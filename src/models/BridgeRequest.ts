/*
Copyright 2019 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

const logging = require("../logging");
const log = logging.get("req");

export class BridgeRequest {
    private log: any;
    constructor(private req: any) {
        const isFromIrc = req.getData() ? Boolean(req.getData().isFromIrc) : false;
        this.log = logging.newRequestLogger(log, req.getId(), isFromIrc);
    }

    getPromise() {
        return this.req.getPromise();
    }

    resolve(thing: any) {
        this.req.resolve(thing);
    }

    reject(err: any) {
        this.req.reject(err);
    }

    public static ERR_VIRTUAL_USER = "virtual-user";
    public static ERR_NOT_MAPPED = "virtual-user";
    public static ERR_DROPPED = "virtual-user";
}