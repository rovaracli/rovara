import { readdir,readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { expect,it } from "vitest";
async function sourceFiles(root:string):Promise<string[]>{const entries=await readdir(root,{withFileTypes:true});return (await Promise.all(entries.map(async entry=>entry.isDirectory()?sourceFiles(path.join(root,entry.name)):/\.(ts|tsx)$/.test(entry.name)?[path.join(root,entry.name)]:[]))).flat();}
function violations(text:string,file="fixture.tsx"){
 const source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),found:string[]=[];
 function visit(node:ts.Node){
  if(ts.isStringLiteralLike(node)||ts.isTemplateHead(node)||ts.isTemplateMiddle(node)||ts.isTemplateTail(node)||ts.isJsxText(node))if(/\u2014|Plan \d|AgentX/.test(node.text))found.push("copy:"+String(source.getLineAndCharacterOfPosition(node.getStart(source)).line+1));
  if((ts.isJsxSelfClosingElement(node)||ts.isJsxOpeningElement(node))&&node.tagName.getText(source)==="IconButton"){
   const label=node.attributes.properties.find((attribute):attribute is ts.JsxAttribute=>ts.isJsxAttribute(attribute)&&attribute.name.getText(source)==="label");
   if(label?.initializer===undefined||ts.isStringLiteral(label.initializer)&&!label.initializer.text.trim()||label.initializer&&ts.isJsxExpression(label.initializer)&&label.initializer.expression===undefined)found.push("icon-label:"+String(source.getLineAndCharacterOfPosition(node.getStart(source)).line+1));
  }
  ts.forEachChild(node,visit);
 }
 visit(source);return found;
}
it("keeps product copy and icon labels consistent across UI and web source",async()=>{const files=[...await sourceFiles("packages/ui/src"),...await sourceFiles("packages/web/src")],found=[];for(const file of files){for(const violation of violations(await readFile(file,"utf8"),file))found.push(file+":"+violation);}expect(found).toEqual([]);});
it("catches copy regressions in literals, templates and visible JSX",()=>{for(const source of ['const a="AgentX"','const a=`Plan 7`','const a=`Before '+String.fromCharCode(0x2014)+' ${value}`','const a=<p>AgentX</p>'])expect(violations(source).some(value=>value.startsWith("copy:"))).toBe(true);expect(violations('const a="Rovara"; // Plan 7 is a source comment')).toEqual([]);});
it("catches missing and empty icon labels, while accepting real labels",()=>{for(const source of ['const a=<IconButton/>','const a=<IconButton label=""/>','const a=<IconButton label={}/>'])expect(violations(source).some(value=>value.startsWith("icon-label:"))).toBe(true);expect(violations('const a=<IconButton label="Close"/>')).toEqual([]);});
