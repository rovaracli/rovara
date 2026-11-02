import { describe, expect, it } from "vitest";
import { nodeTxtResolver, verificationRecordName, type DnsClient } from "../../packages/broker/src/org/company-domains/resolver.js";

// The lookup of a company's verification record: TXT on `_rovara-verify.<domain>` only, bounded, and a failure of the lookup is never "the record is gone".

const err = (code: string) => Object.assign(new Error(`query failed ${code}`), { code });

function client(script: { cname?: string[] | Error; txt?: string[][] | Error; hangMs?: number }): DnsClient & { asked: Array<{ type: string; name: string }>; cancelled: number } {
  const asked: Array<{ type: string; name: string }> = [];
  let cancelled = 0;
  const answer = async <T>(value: T | Error | undefined, fallback: T): Promise<T> => {
    if (script.hangMs !== undefined) await new Promise((resolve) => setTimeout(resolve, script.hangMs));
    const chosen = value ?? fallback;
    if (chosen instanceof Error) throw chosen;
    return chosen;
  };
  return {
    asked,
    get cancelled() { return cancelled; },
    resolveCname: async (name) => { asked.push({ type: "CNAME", name }); return answer(script.cname, []); },
    resolveTxt: async (name) => { asked.push({ type: "TXT", name }); return answer(script.txt, []); },
    cancel: () => { cancelled += 1; },
  };
}

describe("verificationRecordName", () => {
  it("is _rovara-verify. in front of the domain", () => {
    expect(verificationRecordName("acme.example")).toBe("_rovara-verify.acme.example");
  });
});

describe("nodeTxtResolver", () => {
  it("asks for the CNAME and the TXT of that one name, nothing else", async () => {
    const dns = client({ txt: [["rovara-verify=abc"]] });
    const result = await nodeTxtResolver({ make: () => dns }).lookupTxt("_rovara-verify.acme.example");
    expect(result).toEqual({ kind: "records", records: ["rovara-verify=abc"] });
    expect(dns.asked).toEqual([{ type: "CNAME", name: "_rovara-verify.acme.example" }, { type: "TXT", name: "_rovara-verify.acme.example" }]);
  });

  it("joins the chunks of one long record, as DNS splits them", async () => {
    const dns = client({ txt: [["rovara-verify=", "abc"], ["v=spf1 -all"]] });
    expect(await nodeTxtResolver({ make: () => dns }).lookupTxt("_rovara-verify.acme.example")).toEqual({ kind: "records", records: ["rovara-verify=abc", "v=spf1 -all"] });
  });

  it("does not follow a CNAME to another host: a name that is an alias is 'indirect' and its TXT is never read", async () => {
    const dns = client({ cname: ["verify.other-host.example"], txt: [["rovara-verify=abc"]] });
    expect(await nodeTxtResolver({ make: () => dns }).lookupTxt("_rovara-verify.acme.example")).toEqual({ kind: "indirect" });
    expect(dns.asked.map((entry) => entry.type)).toEqual(["CNAME"]);
  });

  it("reads 'no such name' and 'no TXT data' as absent", async () => {
    for (const code of ["ENODATA", "ENOTFOUND"]) {
      const dns = client({ txt: err(code) });
      expect(await nodeTxtResolver({ make: () => dns }).lookupTxt("_rovara-verify.acme.example"), code).toEqual({ kind: "absent" });
    }
  });

  it("reads a failure of the lookup (timeout, server failure, refusal) as unavailable, never as absent", async () => {
    for (const code of ["ETIMEOUT", "ESERVFAIL", "ECONNREFUSED", "EREFUSED", "ECANCELLED", "EWHATEVER"]) {
      expect(await nodeTxtResolver({ make: () => client({ txt: err(code) }) }).lookupTxt("_rovara-verify.acme.example"), code).toEqual({ kind: "unavailable" });
      expect(await nodeTxtResolver({ make: () => client({ cname: err(code) }) }).lookupTxt("_rovara-verify.acme.example"), `cname ${code}`).toEqual({ kind: "unavailable" });
    }
  });

  it("gives up at its own deadline and cancels the lookup", async () => {
    const dns = client({ hangMs: 500 });
    const started = Date.now();
    expect(await nodeTxtResolver({ make: () => dns, deadlineMs: 40 }).lookupTxt("_rovara-verify.acme.example")).toEqual({ kind: "unavailable" });
    expect(Date.now() - started).toBeLessThan(400);
    expect(dns.cancelled).toBe(1);
  });

  it("refuses to look up any name but _rovara-verify. under a normalised domain", async () => {
    const dns = client({ txt: [["rovara-verify=abc"]] });
    const resolver = nodeTxtResolver({ make: () => dns });
    for (const name of ["acme.example", "_other.acme.example", "_rovara-verify.", "_rovara-verify.1.2.3.4", "_rovara-verify.com", "_rovara-verify.ACME.example", "_rovara-verify.acme.example.", "_rovara-verify.a/b.example", "x._rovara-verify.acme.example"]) {
      await expect(resolver.lookupTxt(name), name).rejects.toThrow("record name");
    }
    expect(dns.asked).toEqual([]);
  });

  it("keeps at most 50 records of at most 1024 characters, so a hostile zone cannot fill memory", async () => {
    const many = Array.from({ length: 80 }, (_, index) => [`junk-${String(index)}`]);
    const dns = client({ txt: [...many, ["x".repeat(5000)]] });
    const result = await nodeTxtResolver({ make: () => dns }).lookupTxt("_rovara-verify.acme.example");
    expect(result.kind).toBe("records");
    if (result.kind === "records") {
      expect(result.records.length).toBe(50);
      expect(result.records.every((record) => record.length <= 1024)).toBe(true);
    }
  });
});
