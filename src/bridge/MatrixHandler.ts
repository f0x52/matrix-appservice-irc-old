import { IrcBridge } from "./IrcBridge";
import { Defer } from "../promiseutil";
import { BridgeRequest } from "../models/BridgeRequest";
import { MatrixUser, MatrixRoom, StateLookup, Bridge } from "matrix-appservice-bridge";
import { IrcUser } from "../models/IrcUser";
import { MatrixAction } from "../models/MatrixAction";
import { IrcRoom } from "../models/IrcRoom";
import { IrcClientConfig } from "../models/IrcClientConfig";
import logging from "../logging";
import { BridgedClient } from "../irc/BridgedClient";
import { IrcServer } from "../irc/IrcServer";

const log = logging("MatrixHandler");

const MSG_PMS_DISABLED = "[Bridge] Sorry, PMs are disabled on this bridge.";
const MSG_PMS_DISABLED_FEDERATION = "[Bridge] Sorry, PMs are disabled on " +
"this bridge over federation.";

const KICK_RETRY_DELAY_MS = 15000;
const KICK_DELAY_JITTER = 30000;
/* Number of events to store in memory for use in replies. */
const DEFAULT_EVENT_CACHE_SIZE = 4096;
/* Length of the source text in a formatted reply message */
const REPLY_SOURCE_MAX_LENGTH = 32;

const USER_FEATURES = ["mentions"];

export class MatrixHandler {
    private readonly processingInvitesForRooms: {[roomIdUserId:string]: Promise<unknown>} = {};
    private readonly eventCache: Map<string, {body: string, sender: string}> = new Map();
    private readonly eventCacheMaxSize: number;
    private readonly metrics: {[domain: string]: {
        [metricName: string]: number
    }} = {};
    private readonly mediaUrl: string;
    private memberTracker: StateLookup|null = null;

    constructor(private ircBridge: IrcBridge, config: {eventCacheSize?: number}) {
        // maintain a list of room IDs which are being processed invite-wise. This is
        // required because invites are processed asyncly, so you could get invite->msg
        // and the message is processed before the room is created.
        config = config || {}
        this.eventCacheMaxSize = config.eventCacheSize === undefined ?
            DEFAULT_EVENT_CACHE_SIZE : config.eventCacheSize;
        // The media URL to use to transform mxc:// URLs when handling m.room.[file|image]s
        this.mediaUrl = ircBridge.config.homeserver.media_url || ircBridge.config.homeserver.url;
    }

    // ===== Matrix Invite Handling =====

    /**
     * Process a Matrix invite event for an Admin room.
     * @param {Object} event : The Matrix invite event.
     * @param {Request} req : The request for this event.
     * @param {MatrixUser} inviter : The user who invited the bot.
     * @param {MatrixUser} botUser : The bot it this.
     */
    private async handleAdminRoomInvite(req: BridgeRequest, event: {room_id: string}, inviter: MatrixUser, botUser: MatrixUser) {
        req.log.info("Handling invite from user directed to bot.");
        // Real MX user inviting BOT to a private chat
        let mxRoom = new MatrixRoom(event.room_id);
        await this.ircBridge.getAppServiceBridge().getIntent().join(event.room_id);

        // Do not create an admin room if the room is marked as 'plumbed'
        let matrixClient = this.ircBridge.getAppServiceBridge().getIntent();

        try {
            let plumbedState = await matrixClient.getStateEvent(event.room_id, 'm.room.plumbing');
            if (plumbedState.status === "enabled") {
                req.log.info(
                    'This room is marked for plumbing (m.room.plumbing.status = "enabled"). ' +
                    'Not treating room as admin room.'
                );
                return;
            }
        }
        catch (err) {
            req.log.info(`Not a plumbed room: Error retrieving m.room.plumbing (${err.data.error})`);
        }

        // clobber any previous admin room ID
        await this.ircBridge.getStore().storeAdminRoom(mxRoom, inviter.userId);
    }

    /**
     * Process a Matrix invite event for an Admin room.
     * @param {Object} event : The Matrix invite event.
     * @param {Request} req : The request for this event.
     * @param {IrcUser} invitedIrcUser : The IRC user the bot invited to a room.
     */
    private async handleInviteFromBot(req: BridgeRequest, event: {room_id: string}, invitedIrcUser: IrcUser) {
        req.log.info("Handling invite from bot directed at %s on %s",
            invitedIrcUser.server.domain, invitedIrcUser.nick);
        // Bot inviting VMX to a matrix room which is mapped to IRC. Just make a
        // matrix user and join the room (we trust the bot, so no additional checks)
        let mxUser = await this.ircBridge.getMatrixUser(invitedIrcUser);
        await this.ircBridge.getAppServiceBridge().getIntent(mxUser.getId()).join(event.room_id);
    }

    private async handleInviteFromUser(req: BridgeRequest, event: {room_id: string; sender: string; state_key: string}, invitedIrcUser: IrcUser) {
        req.log.info("Handling invite from user directed at %s on %s",
            invitedIrcUser.server.domain, invitedIrcUser.nick);
        const invitedUser = await this.ircBridge.getMatrixUser(invitedIrcUser);
        const mxRoom = new MatrixRoom(event.room_id);
        const intent = this.ircBridge.getAppServiceBridge().getIntent(invitedUser.getId());
        const mxUser = new MatrixUser(event.sender);
        // Real MX user inviting VMX to a matrix room for PM chat
        if (!invitedIrcUser.server.allowsPms()) {
            req.log.error("Accepting invite, and then leaving: This server does not allow PMs.");
            await intent.join(event.room_id);
            await this.ircBridge.sendMatrixAction(mxRoom, invitedUser, new MatrixAction(
                "notice",
                MSG_PMS_DISABLED
            ));
            await intent.leave(event.room_id);
            return;
        }

        // If no federated PMs are allowed, check the origin of the PM
        //  is same the domain as the bridge
        if (!invitedIrcUser.server.shouldFederatePMs()) {
            // Matches for the local part (the not-user part)
            if (mxUser.host !== this.ircBridge.domain) {
                req.log.error(
                    "Accepting invite, and then leaving: This server does not allow federated PMs."
                );
                await intent.join(event.room_id);
                await this.ircBridge.sendMatrixAction(mxRoom, invitedUser, new MatrixAction(
                    "notice",
                    MSG_PMS_DISABLED_FEDERATION
                ));
                await intent.leave(event.room_id);
                return;
            }
            req.log.info("(PM federation)Invite not rejected: user on local HS");
        }
        else {
            req.log.info("(PM federation)Invite not rejected: federated PMs allowed");
        }
        // create a virtual Matrix user for the IRC user
        await intent.join(event.room_id);
        req.log.info("Joined %s to room %s", invitedUser.getId(), event.room_id);

        // check if this room is a PM room or not.
        const roomState = await intent.roomState(event.room_id);
        const joinedMembers = roomState.filter((ev) =>
            ev.type === "m.room.member" && ev.content.membership === "join"
        ).map((ev) => ev.state_key);
        const isPmRoom = (
            joinedMembers.length === 2 && joinedMembers.includes(event.sender)
        );

        if (isPmRoom) {
            // nick is the channel
            const ircRoom = new IrcRoom(invitedIrcUser.server, invitedIrcUser.nick);
            await this.ircBridge.getStore().setPmRoom(
                ircRoom, mxRoom, event.sender, event.state_key
            );
            return;
        }
        req.log.error("This room isn't a 1:1 chat!");
        // whine that you don't do group chats and leave.
        let notice = new MatrixAction("notice",
            "Group chat not supported."
        );
        try {
            await this.ircBridge.sendMatrixAction(mxRoom, invitedUser, notice);
        }
        catch (err) {
            // ignore, we want to leave the room regardless.
        }
        await intent.leave(event.room_id);
    }

    // === Admin room handling ===
    private async _onAdminMessage(req: BridgeRequest, event: {sender: string, content: {body: string}}, adminRoom: MatrixRoom) {
        req.log.info("Received admin message from %s", event.sender);

        let botUser = new MatrixUser(this.ircBridge.getAppServiceUserId(), undefined, false);

        // If an admin room has more than 2 people in it, kick the bot out
        let members = [];
        if (this.memberTracker) {
            // First call begins tracking, subsequent calls do nothing
            await this.memberTracker.trackRoom(adminRoom.getId());

            members = this.memberTracker.getState(
                adminRoom.getId(),
                'm.room.member'
            ).filter((m) => m.content.membership && m.content.membership === "join");
        }
        else {
            req.log.warn('Member tracker not running');
        }

        if (members.length > 2) {
            req.log.error(
                `_onAdminMessage: admin room has ${members.length}` +
                ` users instead of just 2; bot will leave`
            );

            // Notify users in admin room
            let notice = new MatrixAction("notice",
                "There are more than 2 users in this admin room"
            );
            await this.ircBridge.sendMatrixAction(adminRoom, botUser, notice);

            await this.ircBridge.getAppServiceBridge().getIntent(
                    botUser.getId()
                ).leave(adminRoom.getId());

            return;
        }

        // Assumes all commands have the form "!wxyz [irc.server] [args...]"
        let segments = event.content.body.split(" ");
        let cmd = segments.shift();
        let args = segments;

        if (cmd === "!help") {
            let helpCommands = {
                "!join": {
                    example: `!join [irc.example.net] #channel [key]`,
                    summary: `Join a channel (with optional channel key)`,
                },
                "!nick": {
                    example: `!nick [irc.example.net] DesiredNick`,
                    summary: "Change your nick. If no arguments are supplied, " +
                            "your current nick is shown.",
                },
                "!whois": {
                    example: `!whois [irc.example.net] NickName|@alice:matrix.org`,
                    summary: "Do a /whois lookup. If a Matrix User ID is supplied, " +
                            "return information about that user's IRC connection.",
                },
                "!storepass": {
                    example: `!storepass [irc.example.net] passw0rd`,
                    summary: `Store a NickServ password (server password)`,
                },
                "!removepass": {
                    example: `!removepass [irc.example.net]`,
                    summary: `Remove a previously stored NickServ password`,
                },
                "!feature": {
                    example: `!feature feature-name [true/false/default]`,
                    summary: `Enable, disable or default a feature's status for your account.` +
                            `Will display the current feature status if true/false/default not given.`,
                },
                "!quit": {
                    example: `!quit`,
                    summary: "Leave all bridged channels, on all networks, and remove your " +
                            "connections to all networks.",
                },
                "!cmd": {
                    example: `!cmd [irc.example.net] COMMAND [arg0 [arg1 [...]]]`,
                    summary: "Issue a raw IRC command. These will not produce a reply." +
                            "(Note that the command must be all uppercase.)",
                },
                "!bridgeversion": {
                    example: `!bridgeversion`,
                    summary: "Return the version from matrix-appservice-irc bridge.",
                },
            };


            let notice = new MatrixAction("notice", null,
                `This is an IRC admin room for controlling your IRC connection and sending ` +
                `commands directly to IRC. ` +
                `The following commands are available:<br/><ul>\n\t` +
                Object.values(helpCommands).map((c) => {
                    return (
                        `<li>` +
                        `<strong>${c.example}</strong> : ${c.summary}` +
                        `</li>`
                    );
                }).join(`\n\t`) +
                `</ul>`
            );
            await this.ircBridge.sendMatrixAction(adminRoom, botUser, notice);
            return;
        }

        // Work out which IRC server the command is directed at.
        let clientList = this.ircBridge.getBridgedClientsForUserId(event.sender);
        let ircServer = this.ircBridge.getServer(args[0]);

        if (ircServer) {
            args.shift(); // pop the server so commands don't need to know
        }
        else {
            // default to the server the client is connected to if there is only one
            if (clientList.length === 1) {
                ircServer = clientList[0].server;
            }
            // default to the only server we know about if we only bridge 1 thing.
            else if (this.ircBridge.getServers().length === 1) {
                ircServer = this.ircBridge.getServers()[0];
            }
            else {
                let notice = new MatrixAction("notice",
                    "A server address must be specified."
                );
                await this.ircBridge.sendMatrixAction(adminRoom, botUser, notice);
                return;
            }
        }

        if (cmd === "!nick") {
            // Format is: "!nick irc.example.com NewNick"
            if (!ircServer.allowsNickChanges()) {
                let notice = new MatrixAction("notice",
                    "Server " + ircServer.domain + " does not allow nick changes."
                );
                await this.ircBridge.sendMatrixAction(adminRoom, botUser, notice);
                return;
            }

            let nick = args.length === 1 ? args[0] : null; // make sure they only gave 1 arg
            if (!ircServer || !nick) {
                let connectedNetworksStr = "";
                if (clientList.length === 0) {
                    connectedNetworksStr = (
                        "You are not currently connected to any " +
                        "IRC networks which have nick changes enabled."
                    );
                }
                else {
                    connectedNetworksStr = "Currently connected to IRC networks:\n";
                    for (let i = 0; i < clientList.length; i++) {
                        connectedNetworksStr += clientList[i].server.domain +
                            " as " + clientList[i].nick + "\n";
                    }
                }
                let notice = new MatrixAction("notice",
                    "Format: '!nick DesiredNick' or '!nick irc.server.name DesiredNick'\n" +
                    connectedNetworksStr
                );
                await this.ircBridge.sendMatrixAction(adminRoom, botUser, notice);
                return;
            }
            req.log.info("%s wants to change their nick on %s to %s",
                event.sender, ircServer.domain, nick);

            if (ircServer.claimsUserId(event.sender)) {
                req.log.error("%s is a virtual user!", event.sender);
                return BridgeRequest.ERR_VIRTUAL_USER;
            }

            // change the nick
            let bridgedClient = await this.ircBridge.getBridgedClient(ircServer, event.sender);
            if (bridgedClient) {
                const response = await bridgedClient.changeNick(nick, true);
                const noticeRes = new MatrixAction("notice", response);
                await this.ircBridge.sendMatrixAction(adminRoom, botUser, noticeRes);
            }
            try {
                // persist this desired nick
                let config = await this.ircBridge.getStore().getIrcClientConfig(
                    event.sender, ircServer.domain
                );
                if (!config) {
                    config = IrcClientConfig.newConfig(
                        new MatrixUser(event.sender), ircServer.domain, nick
                    );
                }
                config.setDesiredNick(nick);
                await this.ircBridge.getStore().storeIrcClientConfig(config);
                return;
            }
            catch (err) {
                if (err.stack) {
                    req.log.error(err);
                }
                let noticeErr = new MatrixAction("notice", err.message);
                await this.ircBridge.sendMatrixAction(adminRoom, botUser, noticeErr);
                return;
            }
        }
        else if (cmd === "!join") {
            // TODO: Code dupe from !nick
            // Format is: "!join irc.example.com #channel [key]"

            // check that the server exists and that the user_id is on the whitelist
            let ircChannel = args[0];
            let key = args[1]; // keys can't have spaces in them, so we can just do this.
            let errText = null;
            if (!ircChannel || ircChannel.indexOf("#") !== 0) {
                errText = "Format: '!join irc.example.com #channel [key]'";
            }
            else if (ircServer.hasInviteRooms() && !ircServer.isInWhitelist(event.sender)) {
                errText = "You are not authorised to join channels on this server.";
            }

            if (errText) {
                await this.ircBridge.sendMatrixAction(
                    adminRoom, botUser, new MatrixAction("notice", errText)
                );
                return;
            }
            req.log.info("%s wants to join the channel %s on %s", event.sender, ircChannel, ircServer.domain);

            // There are 2 main flows here:
            //   - The !join is instigated to make the BOT join a new channel.
            //        * Bot MUST join and invite user
            //   - The !join is instigated to make the USER join a new channel.
            //        * IRC User MAY have to join (if bridging incr joins or using a chan key)
            //        * Bot MAY invite user
            //
            // This means that in both cases:
            //  1) Bot joins IRC side (NOP if bot is disabled)
            //  2) Bot sends Matrix invite to bridged room. (ignore failures if already in room)
            // And *sometimes* we will:
            //  3) Force join the IRC user (if given key / bridging joins)

            // track the channel if we aren't already
            let matrixRooms = await this.ircBridge.getStore().getMatrixRoomsForChannel(
                ircServer, ircChannel
            );

            if (matrixRooms.length === 0) {
                // track the channel then invite them.
                // TODO: Dupes onAliasQuery a lot
                const initial_state: unknown[] = [
                    {
                        type: "m.room.join_rules",
                        state_key: "",
                        content: {
                            join_rule: ircServer.getJoinRule()
                        }
                    },
                    {
                        type: "m.room.history_visibility",
                        state_key: "",
                        content: {
                            history_visibility: "joined"
                        }
                    }
                ];
                if (ircServer.areGroupsEnabled()) {
                    initial_state.push({
                        type: "m.room.related_groups",
                        state_key: "",
                        content: {
                            groups: [ircServer.getGroupId() as string]
                        }
                    });
                }
                const ircRoom = await this.ircBridge.trackChannel(ircServer, ircChannel, key);
                const response = await this.ircBridge.getAppServiceBridge().getIntent(
                    event.sender,
                ).createRoom({
                    options: {
                        name: ircChannel,
                        visibility: "private",
                        preset: "public_chat",
                        creation_content: {
                            "m.federate": ircServer.shouldFederate()
                        },
                        initial_state
                    }
                });
                const mxRoom = new MatrixRoom(response.room_id);
                await this.ircBridge.getStore().storeRoom(ircRoom, mxRoom, 'join');
                // /mode the channel AFTER we have created the mapping so we process
                // +s and +i correctly.
                const domain = ircServer.domain;
                this.ircBridge.publicitySyncer.initModeForChannel(ircServer, ircChannel).catch(() => {
                    log.error(
                        `Could not init mode for channel ${ircChannel} on ${domain}`
                    );
                });
                req.log.info(
                    "Created a room to track %s on %s and invited %s",
                    ircRoom.channel, ircServer.domain, event.sender
                );
                matrixRooms.push(mxRoom);
            }

            // already tracking channel, so just invite them.
            const invitePromises = matrixRooms.map((room) => {
                req.log.info(
                    "Inviting %s to room %s", event.sender, room.getId()
                );
                return this.ircBridge.getAppServiceBridge().getIntent().invite(
                    room.getId(), event.sender
                );
            });
            for (const room of matrixRooms) {
                const userMustJoin = (
                    key || ircServer.shouldSyncMembershipToIrc("incremental", room.getId())
                );
                if (!userMustJoin) {
                    continue;
                }
                const bc = await this.ircBridge.getBridgedClient(
                    ircServer, event.sender
                );
                await bc.joinChannel(ircChannel, key);
                break;
            }
            // check whether we should be force joining the IRC user
            for (let i = 0; i < matrixRooms.length; i++) {
                let m = matrixRooms[i];
                let userMustJoin = (
                    key || ircServer.shouldSyncMembershipToIrc("incremental", m.getId())
                );
                if (userMustJoin) {
                    // force join then break out (we only ever join once no matter how many
                    // rooms the channel is bridged to)
                    let bc = await this.ircBridge.getBridgedClient(
                        ircServer, event.sender
                    );
                    await bc.joinChannel(ircChannel, key);
                    break;
                }
            }

            await Promise.all(invitePromises);
        }
        else if (cmd === "!whois") {
            // Format is: "!whois <nick>"

            let whoisNick = args.length === 1 ? args[0] : null; // ensure 1 arg
            if (!whoisNick) {
                await this.ircBridge.sendMatrixAction(
                    adminRoom, botUser,
                    new MatrixAction("notice", "Format: '!whois nick|mxid'")
                );
                return;
            }

            if (whoisNick[0] === "@") {
                // querying a Matrix user - whoisNick is the matrix user ID
                req.log.info("%s wants whois info on %s", event.sender, whoisNick);
                let whoisClient = this.ircBridge.getIrcUserFromCache(ircServer, whoisNick);
                try {
                    let noticeRes = new MatrixAction(
                        "notice",
                        whoisClient ?
                        `${whoisNick} is connected to ${ircServer.domain} as '${whoisClient.nick}'.` :
                        `${whoisNick} has no IRC connection via this bridge.`);
                    await this.ircBridge.sendMatrixAction(adminRoom, botUser, noticeRes);
                }
                catch (err) {
                    if (err.stack) {
                        req.log.error(err);
                    }
                    let noticeErr = new MatrixAction("notice", "Failed to perform whois query.");
                    await this.ircBridge.sendMatrixAction(adminRoom, botUser, noticeErr);
                }
                return;
            }

            req.log.info("%s wants whois info on %s on %s", event.sender,
                whoisNick, ircServer.domain);
            let bridgedClient = await this.ircBridge.getBridgedClient(ircServer, event.sender);
            try {
                let response = await bridgedClient.whois(whoisNick);
                let noticeRes = new MatrixAction("notice", response.msg);
                await this.ircBridge.sendMatrixAction(adminRoom, botUser, noticeRes);
            }
            catch (err) {
                if (err.stack) {
                    req.log.error(err);
                }
                let noticeErr = new MatrixAction("notice", err.message);
                await this.ircBridge.sendMatrixAction(adminRoom, botUser, noticeErr);
            }
            return;
        }
        else if (cmd === "!quit") {
            const msgText = await this.quitUser(
                req, event.sender, clientList, ircServer, "issued !quit command"
            );
            if (msgText) {
                let notice = new MatrixAction("notice", msgText);
                await this.ircBridge.sendMatrixAction(adminRoom, botUser, notice);
            }
            return;
        }
        else if (cmd === "!storepass") {
            let domain = ircServer.domain;
            let userId = event.sender;
            let notice;

            try {
                // Allow passwords with spaces
                let pass = args.join(' ');
                let explanation = `When you next reconnect to ${domain}, this password ` +
                    `will be automatically sent in a PASS command which most ` +
                    `IRC networks will use as your NickServ password. This ` +
                    `means you will not need to talk to NickServ. This does ` +
                    `NOT apply to your currently active connection: you still ` +
                    `need to talk to NickServ one last time to authenticate ` +
                    `your current connection if you haven't already.`;

                if (pass.length === 0) {
                    notice = new MatrixAction(
                        "notice",
                        "Format: '!storepass password' " +
                        "or '!storepass irc.server.name password'\n" + explanation
                    );
                }
                else {
                    await this.ircBridge.getStore().storePass(userId, domain, pass);
                    notice = new MatrixAction(
                        "notice", `Successfully stored password for ${domain}. ` + explanation
                    );
                }
            }
            catch (err) {
                notice = new MatrixAction(
                    "notice", `Failed to store password: ${err.message}`
                );
                req.log.error(err.stack);
            }

            await this.ircBridge.sendMatrixAction(adminRoom, botUser, notice);
            return;
        }
        else if (cmd === "!removepass") {
            let domain = ircServer.domain;
            let userId = event.sender;
            let notice;

            try {
                await this.ircBridge.getStore().removePass(userId, domain);
                notice = new MatrixAction(
                    "notice", `Successfully removed password.`
                );
            }
            catch (err) {
                notice = new MatrixAction(
                    "notice", `Failed to remove password: ${err.message}`
                );
            }

            await this.ircBridge.sendMatrixAction(adminRoom, botUser, notice);
            return;
        }
        else if (cmd === "!cmd" && args[0]) {
            req.log.info(`No valid (old form) admin command, will try new format`);

            // Assumes commands have the form
            // !cmd [irc.server] COMMAND [arg0 [arg1 [...]]]

            let currentServer = ircServer;
            let blacklist = ['PROTOCTL'];

            try {
                let keyword = args[0];

                // keyword could be a failed server or a malformed command
                if (!keyword.match(/^[A-Z]+$/)) {
                    // if not a domain OR is only word (which implies command)
                    if (!keyword.match(/^[a-z0-9:\.-]+$/) || args.length == 1) {
                        throw new Error(`Malformed command: ${keyword}`);
                    }
                    else {
                        throw new Error(`Domain not accepted: ${keyword}`);
                    }
                }

                if (blacklist.indexOf(keyword) != -1) {
                    throw new Error(`Command blacklisted: ${keyword}`);
                }

                // If no args after COMMAND, this will be []
                let sendArgs = args.splice(1);
                sendArgs.unshift(keyword);

                let bridgedClient = await this.ircBridge.getBridgedClient(
                    currentServer, event.sender
                );

                if (!bridgedClient.unsafeClient) {
                    throw new Error('Possibly disconnected');
                }

                bridgedClient.unsafeClient.send.apply(bridgedClient.unsafeClient, sendArgs);
            }
            catch (err) {
                let notice = new MatrixAction("notice", `${err}\n` );
                await this.ircBridge.sendMatrixAction(adminRoom, botUser, notice);
                return;
            }
        }
        else if (cmd === "!bridgeversion") {
            try {
                const BridgeVersion = require("../../package.json").version;
                await this.ircBridge.sendMatrixAction(
                    adminRoom,
                    botUser,
                    new MatrixAction("notice", `BridgeVersion: ${BridgeVersion}`)
                );
            }
            catch (err) {
                let notice = new MatrixAction("notice", "Failed to get bridge version");
                await this.ircBridge.sendMatrixAction(adminRoom, botUser, notice);
                req.log.error(err.stack);
            }
            return;
        }
        else if (cmd === "!feature") {
            if (args.length === 0 || !USER_FEATURES.includes(args[0].toLowerCase())) {
                let notice = new MatrixAction("notice",
                    "Missing or unknown feature flag. Must be one of: " + USER_FEATURES.join(", ")
                );
                await this.ircBridge.sendMatrixAction(adminRoom, botUser, notice);
                return;
            }
            const featureFlag = args[0];
            const features = await this.ircBridge.getStore().getUserFeatures(event.sender);
            if (!args[1]) {
                const val = features[featureFlag];
                let msg = `'${featureFlag}' is `;
                if (val === true) {
                    msg += "enabled.";
                }
                else if (val === false) {
                    msg += "disabled.";
                }
                else {
                    msg += "set to the default value.";
                }
                let notice = new MatrixAction("notice", msg);
                await this.ircBridge.sendMatrixAction(adminRoom, botUser, notice);
                return;
            }
            if (!["true", "false", "default"].includes(args[1].toLowerCase())) {
                let notice = new MatrixAction("notice",
                    "Parameter must be either true, false or default."
                );
                await this.ircBridge.sendMatrixAction(adminRoom, botUser, notice);
                return;
            }
            features[featureFlag] = args[1] === "default" ? undefined :
                args[1].toLowerCase() === "true";

            await this.ircBridge.getStore().storeUserFeatures(event.sender, features);
            let note = "";
            if (featureFlag === "mentions") {
                // We should invalidate caching for this user's channels.
                if (!this.ircBridge.ircHandler.invalidateCachingForUserId(event.sender)) {
                    note = " This bridge has disabled mentions, so this flag will do nothing.";
                }
            }
            let notice = new MatrixAction("notice",
                `Set ${featureFlag} to ${features[featureFlag]}.${note}`
            );
            await this.ircBridge.sendMatrixAction(adminRoom, botUser, notice);
        }
        else {
        let notice = new MatrixAction("notice",
        "The command was not recognised. Available commands are listed by !help");
        await this.ircBridge.sendMatrixAction(adminRoom, botUser, notice);
        }
    }

    public async quitUser(req: BridgeRequest, userId: string, clientList: BridgedClient[], ircServer: IrcServer, reason: string) {
        let clients = clientList;
        if (ircServer) {
            // Filter to get the clients for the [specified] server
            clients = clientList.filter(
                (bridgedClient) => bridgedClient.server.domain === ircServer.domain
            );
        }
        if (clients.length === 0) {
            req.log.info(`No bridgedClients for ${userId}`);
            return "You are not connected to any networks.";
        }

        for (let i = 0; i < clients.length; i++) {
            const bridgedClient = clients[i];
            if (bridgedClient.chanList.length === 0) {
                req.log.info(
                    `Bridged client for ${userId} is not in any channels ` +
                    `on ${bridgedClient.server.domain}`
                );
            }
            else {
                // Get all rooms that the bridgedClient is in
                const uniqueRoomIds = new Set<string>();
                (await Promise.all(
                    bridgedClient.chanList.map(
                        (channel) => {
                            return this.ircBridge.getStore().getMatrixRoomsForChannel(
                                bridgedClient.server, channel
                            );
                        }
                    )
                    // flatten to a single unqiue set
                )).forEach((rSet) => rSet.forEach((r) => uniqueRoomIds.add(r.getId())));

                [...uniqueRoomIds].map((roomId) => {
                    try {
                        await this.ircBridge.getAppServiceBridge().getIntent().kick(
                            roomId, userId, reason
                        );
                    }
                    catch (err) {
                        req.log.error(err);
                        req.log.warn(
                            `Could not kick ${bridgedClient.userId} ` +
                            `from bridged room ${roomId}: ${err.message}`
                        );
                    }
                });
            }

            req.log.info(
                `Killing bridgedClient (nick = ${bridgedClient.nick}) for ${bridgedClient.userId}`
            );
            // The success message will effectively be 'Your connection to ... has been lost.`
            await bridgedClient.kill(reason);
        }

        return null;
    }

    /**
     * Called when the AS receives a new Matrix invite/join/leave event.
     * @param {Object} event : The Matrix member event.
     */
    private _onMemberEvent(req: BridgeRequest, event: unknown) {
        if (!this.memberTracker) {
            let matrixClient = this.ircBridge.getAppServiceBridge().getClientFactory().getClientAs();

            this.memberTracker = new StateLookup({
                client : matrixClient,
                eventTypes: ['m.room.member']
            });
        }
        else {
            this.memberTracker.onEvent(event);
        }
    }

    /**
     * Called when the AS receives a new Matrix invite event.
     * @param {Object} event : The Matrix invite event.
     * @param {MatrixUser} inviter : The inviter (sender).
     * @param {MatrixUser} invitee : The invitee (receiver).
     * @return {Promise} which is resolved/rejected when the request finishes.
     */
    private async _onInvite(req: BridgeRequest, event: {room_id: string, state_key: string, sender: string}, inviter: MatrixUser, invitee: MatrixUser) {
        /*
        * (MX=Matrix user, VMX=Virtual matrix user, BOT=AS bot)
        * Valid invite flows:
        * [1] MX  --invite--> VMX  (starting a PM chat)
        * [2] bot --invite--> VMX  (invite-only room that the bot is in who is inviting virtuals)
        * [3] MX  --invite--> BOT  (admin room; auth)
        * [4] bot --invite--> MX   (bot telling real mx user IRC conn state) - Ignore.
        * [5] irc --invite--> MX   (real irc user PMing a Matrix user) - Ignore.
        */
        req.log.info("onInvite: %s", JSON.stringify(event));
        this._onMemberEvent(req, event);

        // mark this room as being processed in case we simultaneously get
        // messages for this room (which would fail if we haven't done the
        // invite yet!)
        this.processingInvitesForRooms[event.room_id + event.state_key] = req.getPromise();
        req.getPromise().finally(() => {
            delete this.processingInvitesForRooms[event.room_id + event.state_key];
        });


        // work out which flow we're dealing with and fork off asap
        // is the invitee the bot?
        if (this.ircBridge.getAppServiceUserId() === event.state_key) {
            // case [3]
            await this.handleAdminRoomInvite(req, event, inviter, invitee);
        }
        // else is the invitee a real matrix user? If they are, there will be no IRC server
        else if (!this.ircBridge.getServerForUserId(event.state_key)) {
            // cases [4] and [5] : We cannot accept on behalf of real matrix users, so nop
            return BridgeRequest.ERR_NOT_MAPPED;
        }
        else {
            // cases [1] and [2] : The invitee represents a real IRC user
            let ircUser = await this.ircBridge.matrixToIrcUser(invitee);
            // is the invite from the bot?
            if (this.ircBridge.getAppServiceUserId() === event.sender) {
                await this.handleInviteFromBot(req, event, ircUser); // case [2]
            }
            else {
                await this.handleInviteFromUser(req, event, ircUser); // case [1]
            }
        }
    }

    private async _onJoin(req: BridgeRequest, event: {_injected: boolean, room_id: string}, user: MatrixUser) {
        req.log.info("onJoin: %s", JSON.stringify(event));
        this._onMemberEvent(req, event);
        // membershiplists injects leave events when syncing initial membership
        // lists. We know if this event is injected because this flag is set.
        let syncKind = event._injected ? "initial" : "incremental";
        let promises = []; // one for each join request

        if (this.ircBridge.getAppServiceUserId() === user.getId()) {
            // ignore messages from the bot
            return BridgeRequest.ERR_VIRTUAL_USER;
        }

        // is this a tracked channel?
        let ircRooms = await this.ircBridge.getStore().getIrcChannelsForRoomId(event.room_id);

        // =========== Bridge Bot Joining ===========
        // Make sure the bot is joining on all mapped IRC channels
        ircRooms.forEach((ircRoom) => {
            this.ircBridge.joinBot(ircRoom);
        }

        // =========== Client Joining ===========
        // filter out rooms which don't mirror matrix join parts and are NOT frontier
        // entries. Frontier entries must ALWAYS be joined else the IRC channel will
        // not be bridged!
        ircRooms = ircRooms.filter(function(room) {
            return room.server.shouldSyncMembershipToIrc(
                syncKind, event.room_id
            ) || event._frontier;
        }

        if (ircRooms.length === 0) {
            req.log.info(
                "No tracked channels which mirror joins for this room."
            );
            return BridgeRequest.ERR_NOT_MAPPED;
        }

        // for each room (which may be on different servers)
        ircRooms.forEach(function(room) {
            if (room.server.claimsUserId(user.getId())) {
                req.log.info("%s is a virtual user (claimed by %s)",
                    user.getId(), room.server.domain);
                return;
            }
            // get the virtual IRC user for this user
            promises.push(Promise.coroutine(function*() {
                let bridgedClient;
                let kickIntent;
                try {
                    bridgedClient = await this.ircBridge.getBridgedClient(
                        room.server, user.getId(), (event.content || {}).displayname
                    );
                }
                catch (e) {
                    // We need to kick on failure to get a client.
                    req.log.info(`${user.getId()} failed to get a IRC connection. Kicking from room.`);
                    kickIntent = this.ircBridge.getAppServiceBridge().getIntent();
                }

                while (kickIntent) {
                    try {
                        // If they are known blacklisted, get a specific reason string.
                        const excluded = server.isExcludedUser(user.getId());
                        await kickIntent.kick(
                            event.room_id, user.getId(),
                            excluded && excluded.kickReason ? excluded.kickReason
                            : `IRC connection failure.`,
                        );
                        this._incrementMetric(room.server.domain, "connection_failure_kicks");
                        break;
                    }
                    catch (err) {
                        const delay = KICK_RETRY_DELAY_MS + (Math.random() * KICK_DELAY_JITTER);
                        req.log.warn(
                            `User was not kicked. Retrying in ${delay}ms. ${err}`
                        );
                        await Promise.delay(delay);
                    }
                }

                // Check for a displayname change and update nick accordingly.
                if (event.content.displayname !== bridgedClient.displayName) {
                    bridgedClient.displayName = event.content.displayname;
                    // Changing the nick requires that:
                    // - the server allows nick changes
                    // - the nick is not custom
                    let config = await this.ircBridge.getStore().getIrcClientConfig(
                        bridgedClient.userId, room.server.domain
                    );
                    if (room.server.allowsNickChanges() &&
                        !config.getDesiredNick()
                    ) {
                        try {
                            const newNick = room.server.getNick(
                                bridgedClient.userId, event.content.displayname
                            );
                            bridgedClient.changeNick(newNick, false);
                        }
                        catch (e) {
                            req.log.warn(`Didn't change nick on the IRC side: ${e}`);
                        }
                    }
                }

                await bridgedClient.joinChannel(room.channel); // join each channel
            })());
        }

        // We know ircRooms.length > 1. The only time when this isn't mapped into a Promise
        // is when there is a virtual user: TODO: clean this up! Control flow is hard.
        if (promises.length === 0) {
            return BridgeRequest.ERR_VIRTUAL_USER;
        }

        stats.membership(false, "join");
        await Promise.all(promises);
    }

    private async _onKick(req, event, kicker, kickee) {
        req.log.info(
            "onKick %s is kicking/banning %s from %s",
            kicker.getId(), kickee.getId(), event.room_id
        );
        this._onMemberEvent(req, event);

        /*
        We know this is a Matrix client kicking someone.
        There are 2 scenarios to consider here:
        - Matrix on Matrix kicking
        - Matrix on IRC kicking

        Matrix-Matrix
        =============
        __USER A____            ____USER B___
        |            |          |             |
        Matrix     vIRC1       Matrix        vIRC2 |     Effect
        -----------------------------------------------------------------------
        Kicker                 Kickee              |  vIRC2 parts channel.
                                                    This avoids potential permission issues
                                                    in case vIRC1 cannot kick vIRC2 on IRC.

        Matrix-IRC
        ==========
        __USER A____            ____USER B___
        |            |          |             |
        Matrix      vIRC        IRC       vMatrix  |     Effect
        -----------------------------------------------------------------------
        Kicker                            Kickee   |  vIRC tries to kick IRC via KICK command.
        */

        let ircRooms = await this.ircBridge.getStore().getIrcChannelsForRoomId(event.room_id);
        // do we have an active connection for the kickee? This tells us if they are real
        // or virtual.
        let kickeeClients = this.ircBridge.getBridgedClientsForUserId(kickee.getId());

        if (kickeeClients.length === 0) {
            // Matrix on IRC kicking, work out which IRC user to kick.
            let server = null;
            for (let i = 0; i < ircRooms.length; i++) {
                if (ircRooms[i].server.claimsUserId(kickee.getId())) {
                    server = ircRooms[i].server;
                    break;
                }
            }
            if (!server) {
                return; // kicking a bogus user
            }
            let kickeeNick = server.getNickFromUserId(kickee.getId());
            if (!kickeeNick) {
                return; // bogus virtual user ID
            }
            // work out which client will do the kicking
            let kickerClient = this.ircBridge.getIrcUserFromCache(server, kicker.getId());
            if (!kickerClient) {
                // well this is awkward.. whine about it and bail.
                req.log.error(
                    "%s has no client instance to send kick from. Cannot kick.",
                    kicker.getId()
                );
                return;
            }
            // we may be bridging this matrix room into many different IRC channels, and we want
            // to kick this user from all of them.
            for (let i = 0; i < ircRooms.length; i++) {
                if (ircRooms[i].server.domain !== server.domain) {
                    return;
                }
                kickerClient.kick(
                    kickeeNick, ircRooms[i].channel,
                    `Kicked by ${kicker.getId()}` +
                    (event.content.reason ? ` : ${event.content.reason}` : "")
                );
            }
        }
        else {
            // Matrix on Matrix kicking: part the channel.
            let kickeeServerLookup = {};
            kickeeClients.forEach(function(ircClient) {
                kickeeServerLookup[ircClient.server.domain] = ircClient;
            }
            let promises = []; // one for each leave
            ircRooms.forEach(function(ircRoom) {
                // Make the connected IRC client leave the channel.
                let client = kickeeServerLookup[ircRoom.server.domain];
                if (!client) {
                    return; // not connected to this server
                }
                // If we aren't joined this will no-op.
                promises.push(client.leaveChannel(
                    ircRoom.channel,
                    `Kicked by ${kicker.getId()} ` +
                    (event.content.reason ? ` : ${event.content.reason}` : "")
                ));
            }
            await Promise.all(promises);
        }
    }

    private async _onLeave(req, event, user, sender) {
        req.log.info("onLeave: %s", JSON.stringify(event));
        // membershiplists injects leave events when syncing initial membership
        // lists. We know if this event is injected because this flag is set.
        let syncKind = event._injected ? "initial" : "incremental";

        if (this.ircBridge.getAppServiceUserId() === user.getId()) {
            // ignore messages from the bot
            return BridgeRequest.ERR_VIRTUAL_USER;
        }

        // do we have an active connection for this user?
        let clientList = this.ircBridge.getBridgedClientsForUserId(user.getId());
        // filter out servers which don't mirror matrix join parts (unless it's a kick)
        clientList = clientList.filter(function(client) {
            return (
                client.server.shouldSyncMembershipToIrc(syncKind, event.room_id) &&
                !client.server.claimsUserId(user.getId())
            ); // not a virtual user
        }

        let serverLookup = {};
        clientList.forEach(function(ircClient) {
            serverLookup[ircClient.server.domain] = ircClient;
        }


        // which channels should the connected client leave?
        let ircRooms = await this.ircBridge.getStore().getIrcChannelsForRoomId(event.room_id);

        let promises = []; // one for each leave request
        // ========== Client Parting ==========
        // for each room, if we're connected to it, leave the channel.
        ircRooms.forEach(function(ircRoom) {
            // Make the connected IRC client leave the channel.
            let client = serverLookup[ircRoom.server.domain];
            if (!client) {
                return; // not connected to this server
            }
            // leave it; if we aren't joined this will no-op.
            promises.push(client.leaveChannel(ircRoom.channel));
        }

        if (promises.length === 0) { // no connected clients
            return BridgeRequest.ERR_VIRTUAL_USER;
        }

        // =========== Bridge Bot Parting ===========
        // For membership list syncing only
        ircRooms.forEach((ircRoom) => {
            let client = serverLookup[ircRoom.server.domain];
            if (!client) {
                return; // no client left the room, so no need to recheck part room.
            }
            if (!ircRoom.server.isBotEnabled()) {
                return; // don't do expensive queries needlessly
            }
            if (!ircRoom.server.shouldJoinChannelsIfNoUsers()) {
                if (ircRoom.server.domain) {
                    // this = IrcBridge
                    this.ircBridge.memberListSyncers[ircRoom.server.domain].checkBotPartRoom(
                        ircRoom, req
                    );
                }
            }
        }
        stats.membership(false, "part");
        await Promise.all(promises);
    }

    /**
     * Called when the AS receives a new Matrix Event.
     * @param {Request} req
     * @param {Object} event : A Matrix event
     * @return {Promise} which is resolved/rejected when the request finishes.
     */
    private async _onMessage(req, event) {
        let this = this;
        /*
        * Valid message flows:
        * Matrix --> IRC (Bridged communication)
        * Matrix --> Matrix (Admin room)
        */

        req.log.info("%s usr=%s rm=%s body=%s",
            event.type, event.sender, event.room_id,
            (event.content.body ? event.content.body.substring(0, 20) : "")
        );

        // check if this message is from one of our virtual users
        const servers = this.ircBridge.getServers();
        for (let i = 0; i < servers.length; i++) {
            if (servers[i].claimsUserId(event.sender)) {
                req.log.info("%s is a virtual user (claimed by %s)",
                    event.sender, servers[i].domain);
                return BridgeRequest.ERR_VIRTUAL_USER;
            }
        }

        // wait a while if we just got an invite else we may not have the mapping stored
        // yet...
        if (this._processingInvitesForRooms[event.room_id + event.sender]) {
            req.log.info(
                "Holding request for %s until invite for room %s is done.",
                event.sender, event.room_id
            );
            await this._processingInvitesForRooms[event.room_id + event.sender];
            req.log.info(
                "Finished holding event for %s in room %s", event.sender, event.room_id
            );
        }

        if (this.ircBridge.getAppServiceUserId() === event.sender) {
            // ignore messages from the bot
            return BridgeRequest.ERR_VIRTUAL_USER;
        }


        let mxAction = MatrixAction.fromEvent(
            event, this._mediaUrl
        );
        let ircAction = IrcAction.fromMatrixAction(mxAction);
        let ircRooms = await this.ircBridge.getStore().getIrcChannelsForRoomId(event.room_id);

        // Sometimes bridge's message each other and get stuck in a silly loop. Ensure it's m.text
        if (ircRooms.length === 0 && event.content && event.content.msgtype === "m.text") {
            // could be an Admin room, so check.
            let adminRoom = await this.ircBridge.getStore().getAdminRoomById(event.room_id);
            if (!adminRoom) {
                req.log.info("No mapped channels.");
                return;
            }
            // process admin request
            await this._onAdminMessage(req, event, adminRoom);
            return;
        }

        let promises = [];

        // Check for other matrix rooms which are bridged to this channel.
        // If there are other rooms, send this message directly to that room as the virtual matrix user.
        // E.g: send this message to MROOM2 and MROOM3:
        //
        // MROOM1            MROOM2             MROOM3
        //   |                 |                  |
        //   +->>MSG>>----------------------------+
        //                 |                  |
        //                #chan              #chan2
        //
        let otherMatrixRoomIdsToServers = Object.create(null);
        let otherPromises = [];

        ircRooms.forEach((ircRoom) => {
            if (ircRoom.server.claimsUserId(event.sender)) {
                req.log.info("%s is a virtual user (claimed by %s)",
                    event.sender, ircRoom.server.domain);
                return;
            }
            req.log.info("Relaying message in %s on %s",
                ircRoom.channel, ircRoom.server.domain);

            if (ircRoom.getType() === "channel") {
                otherPromises.push(
                    this.ircBridge.getStore().getMatrixRoomsForChannel(
                        ircRoom.server, ircRoom.channel
                    ).then((otherMatrixRooms) => {
                        otherMatrixRooms.forEach((mxRoom) => {
                            otherMatrixRoomIdsToServers[mxRoom.getId()] = ircRoom.server;
                        }
                    })
                );
            }

            // If we already have a cached client then yay, but if we
            // don't then we need to hit out for their display name in
            // this room.
            if (!this.ircBridge.getIrcUserFromCache(ircRoom.server, event.sender)) {
                promises.push(Promise.coroutine(function*() {
                    let displayName = undefined;
                    try {
                        let res = await this.ircBridge.getAppServiceBridge().getBot()
                        .getClient().getStateEvent(
                            event.room_id, "m.room.member", event.sender
                        );
                        displayName = res.displayname;
                    }
                    catch (err) {
                        req.log.error("Failed to get display name: %s", err);
                        // this is non-fatal, continue.
                    }
                    let ircUser = await this.ircBridge.getBridgedClient(
                        ircRoom.server, event.sender, displayName
                    );

                    await this._sendIrcAction(req, ircRoom, ircUser, ircAction, event);
                })());
            }
            else {
                // push each request so we don't block processing other rooms
                promises.push(Promise.coroutine(function*() {
                    let ircUser = await this.ircBridge.getBridgedClient(
                        ircRoom.server, event.sender
                    );
                    await this._sendIrcAction(req, ircRoom, ircUser, ircAction, event);
                })());
            }
        }

        await Promise.all(otherPromises);
        Object.keys(otherMatrixRoomIdsToServers).forEach((roomId) => {
            if (roomId === event.room_id) {
                return; // don't bounce back to the sender
            }
            let otherServer = otherMatrixRoomIdsToServers[roomId];
            // convert the sender's user ID to a nick and back to a virtual user for this server
            // then send from that user ID (yuck!).
            let n = otherServer.getNick(event.sender);
            let virtUserId = otherServer.getUserIdFromNick(n);
            promises.push(
                this.ircBridge.sendMatrixAction(
                    new MatrixRoom(roomId), new MatrixUser(virtUserId), mxAction
                )
            );
        }

        await Promise.all(promises);
    }

    private async sendIrcAction(req, ircRoom, ircClient, ircAction, event) {
        // Send the action as is if it is not a text message
        if (event.content.msgtype !== "m.text") {
            await this.ircBridge.sendIrcAction(ircRoom, ircClient, ircAction);
            return;
        }

        let text = event.content.body;
        let cacheBody = text;
        if (event.content["m.relates_to"] && event.content["m.relates_to"]["m.in_reply_to"]) {
            const reply = await this._textForReplyEvent(event, ircRoom);
            if (reply !== undefined) {
                ircAction.text = text = reply.formatted;
                cacheBody = reply.reply;
            }
        }
        this._eventCache.set(event.event_id, {
            body: cacheBody.substr(0, REPLY_SOURCE_MAX_LENGTH),
            sender: event.sender
        }

        // Cache events in here so we can refer to them for replies.
        if (this._eventCache.size > this._eventCacheMaxSize) {
            const delKey = this._eventCache.entries().next().value[0];
            this._eventCache.delete(delKey);
        }

        // Check for the existance of the getSplitMessages method.
        if (!(ircClient.unsafeClient && ircClient.unsafeClient.getSplitMessages)) {
            await this.ircBridge.sendIrcAction(ircRoom, ircClient, ircAction);
            return;
        }

        // Generate an array of individual messages that would be sent
        let potentialMessages = ircClient.unsafeClient.getSplitMessages(ircRoom.channel, text);
        let lineLimit = ircRoom.server.getLineLimit();

        if (potentialMessages.length <= lineLimit) {
            await this.ircBridge.sendIrcAction(ircRoom, ircClient, ircAction);
            return;
        }

        // Message body too long, upload to HS instead

        // Use the current ISO datetime as the name of the file
        //  strip off milliseconds and replace 'T' with an underscore
        //  result e.g : 2016-08-03T10:40:48.620Z becomes 2016-08-03_10:40:48
        let fileName = new Date().toISOString()
            .split(/[T|\.]/)
            .splice(0, 2)
            .join('_') + '.txt';

        // somenick_2016-08-03_10:40:48.txt
        fileName = ircClient.nick + '_' + fileName;

        let result = {};

        try {
            // Try to upload as a file and get URI
            //  (this could fail, see the catch statement)
            let response = await this.ircBridge.uploadTextFile(fileName, text);
            result = JSON.parse(response);
        }
        catch (err) {
            // Uploading the file to HS could fail
            req.log.error("Failed to upload text file ", err);
        }

        // This is true if the upload was a success
        if (result.content_uri) {
            // Alter event object so that it is treated as if a file has been uploaded
            event.content.url = result.content_uri;
            event.content.msgtype = "m.file";
            event.content.body = "sent a long message: ";

            // Create a file event to reflect the recent upload
            let mAction = MatrixAction.fromEvent(event, this._mediaUrl);
            let bigFileIrcAction = IrcAction.fromMatrixAction(mAction);

            // Replace "Posted a File with..."
            bigFileIrcAction.text = mAction.text;

            // Notify the IRC side of the uploaded text file
            await this.ircBridge.sendIrcAction(ircRoom, ircClient, bigFileIrcAction);
        }
        else {
            req.log.warn("Sending truncated message");
            // Modify the event to become a truncated version of the original
            //  the truncation limits the number of lines sent to lineLimit.

            let msg = '\n...(truncated)';

            event.content = {
                msgtype : "m.text",
                body : potentialMessages.splice(0, lineLimit - 1).join('\n') + msg
            };

            // Recreate action from modified event
            let truncatedIrcAction = IrcAction.fromMatrixAction(
                MatrixAction.fromEvent(
                    this.ircBridge.getAppServiceBridge().getClientFactory().getClientAs(),
                    event,
                    this._mediaUrl
                )
            );

            await this.ircBridge.sendIrcAction(ircRoom, ircClient, truncatedIrcAction);
        }
    }

    /**
     * Called when the AS receives an alias query from the HS.
     * @param {string} roomAlias : The room alias queried.
     * @return {Promise} which is resolved/rejected when the request finishes.
     */
    private async _onAliasQuery(req, roomAlias) {
        req.log.info("onAliasQuery %s", roomAlias);

        // check if alias maps to a valid IRC server and channel
        let channelInfo = this.ircBridge.aliasToIrcChannel(roomAlias);
        if (!channelInfo.channel) {
            throw new Error("Unknown alias: " + roomAlias); // bad alias
        }
        if (!channelInfo.server.createsPublicAliases()) {
            throw new Error("This server does not allow alias mappings.");
        }
        req.log.info("Mapped to %s on %s",
            channelInfo.channel, channelInfo.server.domain
        );

        // See if we are already tracking this channel (case-insensitive
        // channels but case-sensitive aliases)
        let matrixRooms = await this.ircBridge.getStore().getMatrixRoomsForChannel(
            channelInfo.server, channelInfo.channel
        );
        if (matrixRooms.length === 0) {
            // ====== Track the IRC channel
            // lower case the name to join (there's a bug in the IRC lib
            // where the join callback never fires if you try to join
            // #WithCaps in channels :/)
            channelInfo.channel = toIrcLowerCase(channelInfo.channel);
            req.log.info("Going to track IRC channel %s", channelInfo.channel);
            // join the irc server + channel
            await this.ircBridge.trackChannel(channelInfo.server, channelInfo.channel);
            req.log.info("Bot is now tracking IRC channel.");

            // ======== Create the Matrix room
            let newRoomId = null;
            let botIntent = this.ircBridge.getAppServiceBridge().getIntent();
            try { // make the matrix room
                const initial_state = [
                    {
                        type: "m.room.join_rules",
                        state_key: "",
                        content: {
                            join_rule: channelInfo.server.getJoinRule()
                        }
                    },
                    {
                        type: "m.room.history_visibility",
                        state_key: "",
                        content: {
                            history_visibility: "joined"
                        }
                    }
                ];
                if (channelInfo.server.areGroupsEnabled()) {
                    initial_state.push({
                        type: "m.room.related_groups",
                        state_key: "",
                        content: {
                            groups: [channelInfo.server.getGroupId()]
                        }
                    }
                }
                const options = {
                    room_alias_name: roomAlias.split(":")[0].substring(1), // localpart
                    name: channelInfo.channel,
                    visibility: "private",
                    preset: "public_chat",
                    creation_content: {
                        "m.federate": channelInfo.server.shouldFederate()
                    },
                    initial_state
                };
                if (channelInfo.server.forceRoomVersion()) {
                    options.room_version = channelInfo.server.forceRoomVersion();
                }
                const res = await botIntent.createRoom({
                    options,
                }
                newRoomId = res.room_id;
            }
            catch (e) {
                if (e && e.errorcode === "M_UNKNOWN") {
                    // alias already taken, must be us. Join the room alias.
                    let room = await botIntent.join(alias);
                    newRoomId = room.getId();
                }
                else {
                    req.log.error("Failed to create room: %s", e.stack);
                    throw e;
                }
            }

            let matrixRoom = new MatrixRoom(newRoomId);
            req.log.info("Matrix room %s created.", matrixRoom.getId());

            // TODO set topic, add matrix members f.e. irc user(?) given
            // they are cheap to do.

            // ========= store the mapping and return OK
            let ircRoom = new IrcRoom(channelInfo.server, channelInfo.channel);
            await this.ircBridge.getStore().storeRoom(ircRoom, matrixRoom, 'alias');

            // /mode the channel AFTER we have created the mapping so we process +s and +i correctly.
            this.ircBridge.publicitySyncer.initModeForChannel(
                channelInfo.server, channelInfo.channel
            ).catch((err) => {
                log.error(
                    `Could not init mode for channel ${channelInfo.channel} on ` +
                    `${channelInfo.server.domain}`
                );
            }
        }
        else {
            // create an alias pointing to this room (take first)
            // TODO: Take first with public join_rules
            let roomId = matrixRooms[0].getId();
            req.log.info("Pointing alias %s to %s", roomAlias, roomId);
            await this.ircBridge.getAppServiceBridge().getBot().getClient().createAlias(
                roomAlias, roomId
            );
        }
    }

    /**
     * Called when the AS receives a user query from the HS.
     * @param {string} userId : The user ID queried.
     * @return {Promise} which is resolved/rejected when the request finishes.
     */
    private async _onUserQuery(req, userId) {
        if (this.ircBridge.getAppServiceUserId() === userId) {
            return;
        }
        req.log.info("onUserQuery: %s", userId);
        let matrixUser = new MatrixUser(userId);
        let ircUser = await this.ircBridge.matrixToIrcUser(matrixUser);
        await this.ircBridge.getMatrixUser(ircUser);
    }

    private async textForReplyEvent(event, ircRoom) {
        const REPLY_REGEX = /> <(@.*:.*)>(.*)\n\n(.*)/;
        const REPLY_NAME_MAX_LENGTH = 12;
        const eventId = event.content["m.relates_to"]["m.in_reply_to"].event_id;
        const match = REPLY_REGEX.exec(event.content.body);
        if (match.length !== 4) {
            return;
        }

        let rplName;
        let rplSource;
        const rplText = match[3];
        if (!this._eventCache.has(eventId)) {
            // Fallback to fetching from the homeserver.
            try {
                const eventContent = await this.ircBridge.getAppServiceBridge().getIntent().getEvent(
                    event.room_id, eventId
                );
                rplName = eventContent.sender;
                if (typeof(eventContent.content.body) !== "string") {
                    throw Error("'body' was not a string.");
                }
                const isReply = eventContent.content["m.relates_to"] &&
                    eventContent.content["m.relates_to"]["m.in_reply_to"];
                if (isReply) {
                    const sourceMatch = REPLY_REGEX.exec(eventContent.content.body);
                    rplSource = sourceMatch.length === 4 ? sourceMatch[3] : event.content.body;
                }
                else {
                    rplSource = eventContent.content.body;
                }
                rplSource = rplSource.substr(0, REPLY_SOURCE_MAX_LENGTH);
                this._eventCache.set(eventId, {sender: rplName, body: rplSource});
            }
            catch (err) {
                // If we couldn't find the event, then frankly we can't
                // trust it and we won't treat it as a reply.
                return {
                    formatted: rplText,
                    reply: rplText,
                };
            }
        }
        else {
            rplName = this._eventCache.get(eventId).sender;
            rplSource = this._eventCache.get(eventId).body;
        }

        // Get the first non-blank line from the source.
        const lines = rplSource.split('\n').filter((line) => !/^\s*$/.test(line))
        if (lines.length > 0) {
            // Cut to a maximum length.
            rplSource = lines[0].substr(0, REPLY_SOURCE_MAX_LENGTH);
            // Ellipsis if needed.
            if (lines[0].length > REPLY_SOURCE_MAX_LENGTH) {
                rplSource = rplSource + "...";
            }
            // Wrap in formatting
            rplSource = ` "${rplSource}"`;
        }
        else {
            // Don't show a source because we couldn't format one.
            rplSource = "";
        }

        // Fetch the sender's IRC nick.
        const sourceClient = this.ircBridge.getIrcUserFromCache(ircRoom.server, rplName);
        if (sourceClient) {
            rplName = sourceClient.nick;
        }
        else {
            // If we couldn't find a client for them, they might be a ghost.
            const ghostName = ircRoom.getServer().getNickFromUserId(rplName);
            // If we failed to get a name, just make a guess of it.
            rplName = ghostName !== null ? ghostName : rplName.substr(1,
                Math.min(REPLY_NAME_MAX_LENGTH, rplName.indexOf(":") - 1)
            );
        }

        return {
            formatted: `<${rplName}${rplSource}> ${rplText}`,
            reply: rplText,
        };
    }

    private incrementMetric(serverDomain: string, metricName: string) {
        let metricSet = this.metrics[serverDomain];
        if (!metricSet) {
            metricSet = this.metrics[serverDomain] = {};
        }
        if (metricSet[metricName] === undefined) {
            metricSet[metricName] = 1;
        }
        else {
            metricSet[metricName]++;
        }
        this.metrics[serverDomain] = metricSet;
    }

    // EXPORTS

    public onMemberEvent(req: BridgeRequest, event, inviter, invitee) {
        return reqHandler(req, this._onMemberEvent(req, event, inviter, invitee));
    };

    public onInvite(req: BridgeRequest, event, inviter, invitee) {
        return reqHandler(req, this._onInvite(req, event, inviter, invitee));
    };

    public onJoin(req: BridgeRequest, event, user) {
        return reqHandler(req, this._onJoin(req, event, user));
    };

    public onLeave(req: BridgeRequest, event, user, sender) {
        return reqHandler(req, this._onLeave(req, event, user, sender));
    };

    public onKick(req: BridgeRequest, event, kicker, kickee) {
        return reqHandler(req, this._onKick(req, event, kicker, kickee));
    };

    public onMessage(req: BridgeRequest, event) {
        return reqHandler(req, this._onMessage(req, event));
    };

    public onAliasQuery(req: BridgeRequest, alias) {
        return reqHandler(req, this._onAliasQuery(req, alias));
    };

    public onUserQuery(req: BridgeRequest, userId) {
        return reqHandler(req, this._onUserQuery(req, userId))
    };

    public getMetrics(serverDomain: string) {
        const metrics = this.metrics[serverDomain] || {};
        this.metrics[serverDomain] = {}
        return metrics || {};
    }
}

function reqHandler(req: BridgeRequest, promise: PromiseLike<unknown>) {
    return promise.then(function(res) {
        req.resolve(res);
        return res;
    }, function(err) {
        req.reject(err);
        throw err;
    });
}
