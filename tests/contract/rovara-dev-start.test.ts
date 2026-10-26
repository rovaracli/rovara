import { readFileSync } from "node:fs";
import vm from "node:vm";
import { expect,it,vi } from "vitest";
const script=readFileSync("web/rovara-dev-start/start.js","utf8");
for(const cellUrl of ["https://cell.example","https://cell.example/base/","http://cell.example","https://user@cell.example","https://cell.example?next=evil","https://cell.example#x","javascript:alert(1)","https://cell.example\\evil"])it("validates the configured signup destination "+cellUrl,async()=>{
 const replace=vi.fn(),message={textContent:""},fetch=vi.fn(async()=>({ok:true,json:async()=>({cellUrl})}));vm.runInNewContext(script,{URL,fetch,document:{getElementById:()=>message},location:{replace}});for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));
 if(cellUrl==="https://cell.example"||cellUrl==="https://cell.example/base/")expect(replace).toHaveBeenCalledWith(cellUrl.replace(/\/$/,"")+"/app/signup");else{expect(replace).not.toHaveBeenCalled();expect(message.textContent).toContain("not reachable");}
 expect(fetch).toHaveBeenCalledWith("./cell.json",{cache:"no-store",credentials:"omit",referrerPolicy:"no-referrer"});
});
