"use strict";
// A very small PostgreSQL client (simple query protocol, SCRAM-SHA-256 or cleartext password), so the escape project needs no package: the sealed round has no registry. One query, text results, no TLS.
const net = require("node:net");
const crypto = require("node:crypto");

const int32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const message = (type, body) => Buffer.concat([Buffer.from(type), int32(body.length + 4), body]);
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

function scramFinal(password, clientFirstBare, serverFirst, nonce) {
  const fields = Object.fromEntries(serverFirst.split(",").map((part) => [part[0], part.slice(2)]));
  if (!fields.r || !fields.r.startsWith(nonce)) throw new Error("the server's nonce does not extend ours");
  const salted = crypto.pbkdf2Sync(password, Buffer.from(fields.s, "base64"), Number(fields.i), 32, "sha256");
  const clientKey = hmac(salted, "Client Key");
  const storedKey = crypto.createHash("sha256").update(clientKey).digest();
  const withoutProof = `c=biws,r=${fields.r}`;
  const authMessage = `${clientFirstBare},${serverFirst},${withoutProof}`;
  const signature = hmac(storedKey, authMessage);
  const proof = Buffer.from(clientKey.map((byte, index) => byte ^ signature[index]));
  return { final: `${withoutProof},p=${proof.toString("base64")}`, serverSignature: hmac(hmac(salted, "Server Key"), authMessage).toString("base64") };
}

/** Runs one query and resolves to its rows (arrays of strings or null). */
function query(databaseUrl, sql, { timeoutMs = 10_000 } = {}) {
  const url = new URL(databaseUrl);
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const database = url.pathname.replace(/^\//, "") || user;
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: url.hostname, port: Number(url.port || 5432) });
    const rows = [];
    let buffer = Buffer.alloc(0);
    let nonce = "";
    let clientFirstBare = "";
    let expectedServerSignature = "";
    let settled = false;
    const finish = (error) => { if (settled) return; settled = true; socket.destroy(); if (error) reject(error); else resolve(rows); };
    socket.setTimeout(timeoutMs, () => finish(new Error("the database did not answer in time")));
    socket.once("error", finish);
    socket.once("connect", () => {
      const params = Buffer.from(`user\0${user}\0database\0${database}\0\0`);
      socket.write(Buffer.concat([int32(params.length + 8), int32(196608), params]));
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        for (;;) {
          if (buffer.length < 5) return;
          const length = buffer.readInt32BE(1);
          if (buffer.length < length + 1) return;
          const type = String.fromCharCode(buffer[0]);
          const body = buffer.subarray(5, length + 1);
          buffer = buffer.subarray(length + 1);
          if (type === "R") {
            const code = body.readInt32BE(0);
            if (code === 3) socket.write(message("p", Buffer.from(`${password}\0`)));
            else if (code === 10) {
              nonce = crypto.randomBytes(18).toString("base64");
              clientFirstBare = `n=,r=${nonce}`;
              const first = Buffer.from(`n,,${clientFirstBare}`);
              socket.write(message("p", Buffer.concat([Buffer.from("SCRAM-SHA-256\0"), int32(first.length), first])));
            } else if (code === 11) {
              const serverFirst = body.subarray(4).toString();
              const result = scramFinal(password, clientFirstBare, serverFirst, nonce);
              expectedServerSignature = result.serverSignature;
              socket.write(message("p", Buffer.from(result.final)));
            } else if (code === 12) {
              if (body.subarray(4).toString() !== `v=${expectedServerSignature}`) throw new Error("the server's signature is wrong");
            } else if (code !== 0) throw new Error(`unsupported authentication method ${code}`);
          } else if (type === "Z") {
            if (rows.sent) finish();
            else { rows.sent = true; socket.write(message("Q", Buffer.from(`${sql}\0`))); }
          } else if (type === "D") {
            const columns = body.readInt16BE(0);
            let at = 2;
            const row = [];
            for (let i = 0; i < columns; i += 1) {
              const size = body.readInt32BE(at); at += 4;
              if (size < 0) row.push(null); else { row.push(body.subarray(at, at + size).toString()); at += size; }
            }
            rows.push(row);
          } else if (type === "E") {
            throw new Error(`the database refused: ${body.toString().replace(/\0/g, " ").slice(0, 200)}`);
          }
        }
      } catch (error) { finish(error); }
    });
  });
}

module.exports = { query };
