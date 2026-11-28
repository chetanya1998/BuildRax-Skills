import Redis from "ioredis";
// One shared client on purpose: each Redis connection costs a socket, so routes reuse this one.
export const cache = new Redis();
