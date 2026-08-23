import puppeteer from "puppeteer-core";
const EDGE="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const OUT=process.argv[2],NAV=process.argv[3].replace(/\/g,"/"),COORD=process.argv[4];
const b=await puppeteer.launch({executablePath:EDGE,headless:"new",args:["--no-sandbox","--use-gl=swiftshader","--window-size=1200,820"]});
const p=await b.newPage();await p.setViewport({width:1200,height:820});
await p.goto("http://localhost:3000/xi-visualizer/",{waitUntil:"networkidle0"});
await p.evaluate(()=>[...document.querySelectorAll("a")].find(a=>a.textContent.trim()==="Navmesh")?.click());
await new Promise(r=>setTimeout(r,600));
await (await p.$('input[type="file"]')).uploadFile(NAV);
await new Promise(r=>setTimeout(r,1500));
const stats=await p.evaluate(()=>document.querySelector(".w-56")?.innerText.split("\n").slice(0,6).join(" | ")||"");
console.log("PANEL:",stats);
await p.evaluate(()=>{const l=[...document.querySelectorAll("label")].find(x=>/Color by island/i.test(x.textContent));const cb=l?.querySelector("input");if(cb&&!cb.checked)cb.click();});
if(COORD){await p.evaluate(c=>{const inp=[...document.querySelectorAll('input[type="text"]')].pop();const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;s.call(inp,c);inp.dispatchEvent(new Event("input",{bubbles:true}));},COORD);await p.evaluate(()=>[...document.querySelectorAll("button")].find(x=>x.textContent.trim()==="Go")?.click());await new Promise(r=>setTimeout(r,700));}
const cv=await p.$("canvas");const box=await cv.boundingBox();
for(let i=0;i<3;i++){await p.mouse.move(box.x+box.width/2,box.y+box.height/2);await p.mouse.wheel({deltaY:-200});}
await new Promise(r=>setTimeout(r,400));
await p.screenshot({path:OUT});console.log("shot ->",OUT);await b.close();
