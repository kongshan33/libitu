import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureRecords, installLoadoutFixture, loadoutOwner } from "./helpers/loadout-fixture.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LIBITU_PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.env.LIBITU_TEST_URL ?? "http://localhost:3000";
const artifacts = await mkdtemp(join(tmpdir(), "libitu-corpus-"));
const analysis = {
  analysisSource: "ai", selectionType: "phrase", completeness: "complete", selectedText: "to be fair", recommendedText: "to be fair", recommendationReason: "",
  fields: {kind:"chunk",tags:["softening"],level:"B1",register:"neutral"}, notePlaceholder:"",
  explanation: { pronunciation: { ipa: "/tə bi feə/", connectedSpeech: "Link the words.", audioText:"to be fair" }, meaning:"Acknowledge another perspective.", pragmaticFunction:"Concede before a counterpoint.", similarExpressions:["in fairness"], examples:[{english:"To be fair, the plan worked.",chinese:"公平地说，这个计划奏效了。"}],usageChips:["workplace"] },
  syntaxAnalysis: { sentenceType:"phrase", mainClause:"The plan worked.", structureBreakdown:["Discourse marker before the main clause."],logicRelations:[],informationHierarchy:[],styleFeatures:[],usageScenarios:[],grammarPoints:[],wordingNotes:[],reusablePatterns:[],translations:[],translationNotes:[],evidence:["To be fair, the plan worked."] }
};
const records = fixtureRecords.map((record,index) => ({ ...record, createdAt:`2026-09-${String(10+index).padStart(2,"0")}T00:00:00Z`, item: { ...record.item, level:index%2?"B2":"B1", tags:index%2?["framing"]:["softening"], register:"professional", scenarioTags:[index<5?"workplace":"everyday"], learningValueScore:index%2?3:5, ...(index===4 ? { analysisDetail:{ context:{selectedText:"to be fair",currentSentence:"To be fair, the plan worked.",contextBefore:"Let's look at the results.",timestamp:"0:01"},analysis } } : {}) } }));
const browser = await chromium.launch({headless:true,channel:process.env.LIBITU_BROWSER_CHANNEL??"chrome"});
try {
  for (const viewport of [{width:1440,height:1000},{width:390,height:844}]) {
    const context = await browser.newContext({viewport}); const page = await context.newPage(); page.setDefaultTimeout(30000);
    const state = await installLoadoutFixture(page,{origin,records});
    let failPatch = false;
    await page.route("**/api/corpus/*",async route => {
      const request=route.request(); const headers={"access-control-allow-origin":"*","access-control-allow-headers":"content-type,authorization","access-control-allow-methods":"GET,POST,PATCH,DELETE,OPTIONS"};
      if(request.method()==="OPTIONS") return route.fulfill({status:204,headers});
      const owner=JSON.parse(Buffer.from(request.headers().authorization.split(" ")[1].split(".")[1],"base64url").toString()).sub;
      const id=new URL(request.url()).pathname.split("/").pop(); const cloud=state.cloud.get(owner);
      const entry=[...cloud.entries()].find(([,row])=>row.id===id);
      if(!entry) return route.fulfill({status:404,headers,json:{}});
      if(request.method()==="PATCH") {
        if(failPatch) { failPatch=false; return route.fulfill({status:503,headers,json:{detail:"offline"}}); }
        const row={...entry[1],...request.postDataJSON(),updated_at:new Date().toISOString()}; cloud.set(entry[0],row); return route.fulfill({headers,json:row});
      }
      if(request.method()==="DELETE") { cloud.delete(entry[0]); return route.fulfill({status:204,headers}); }
      throw new Error(`Unexpected detail API: ${request.method()}`);
    });
    await page.goto(`${origin}/corpus`,{waitUntil:"domcontentloaded",timeout:60000});
    await page.getByText("10 items shown",{exact:true}).waitFor();
    console.log(`Loaded ${viewport.width}px`);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    await page.screenshot({path:join(artifacts,`library-${viewport.width}.png`),fullPage:true});
    await page.getByRole("checkbox",{name:"Select to be fair",exact:true}).check();
    await page.getByRole("searchbox",{name:"Search corpus"}).fill("break the ice");
    await page.getByText("1 items shown",{exact:true}).waitFor();
    assert.equal(await page.getByRole("checkbox",{name:"Select break the ice",exact:true}).isChecked(),false);
    await page.getByText("1 selected · 1 hidden by filters",{exact:true}).waitFor();
    await page.getByRole("searchbox",{name:"Search corpus"}).fill("");
    await page.getByRole("button",{name:"View to be fair",exact:true}).click();
    const dialog=page.getByRole("dialog"); await dialog.getByText("Original analysis · to be fair",{exact:true}).waitFor();
    await dialog.getByRole("button",{name:"Syntax",exact:true}).click();
    await dialog.getByText("Discourse marker before the main clause.",{exact:true}).waitFor();
    await page.screenshot({path:join(artifacts,`detail-${viewport.width}.png`)});
    await dialog.getByRole("button",{name:"Edit item",exact:true}).click();
    await dialog.getByLabel("Expression or structure",{exact:true}).fill("In fairness");
    await dialog.getByLabel("Meaning",{exact:true}).fill("My revised meaning");
    await dialog.getByRole("button",{name:"Save changes",exact:true}).click();
    await dialog.getByText("Changes saved.",{exact:true}).waitFor();
    await dialog.getByRole("button",{name:"Close corpus detail"}).click();
    assert.equal(await page.getByRole("checkbox",{name:"Select In fairness",exact:true}).isChecked(),true);
    console.log(`Guest edit saved ${viewport.width}px`);
    await page.reload({waitUntil:"domcontentloaded"});
    await page.getByRole("button",{name:"View In fairness",exact:true}).waitFor();
    await page.getByRole("button",{name:"List view",exact:true}).click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    if(viewport.width<760) await page.getByRole("button",{name:"Filters",exact:true}).click();
    await page.getByRole("group",{name:"Type",exact:true}).getByRole("button",{name:"idiom",exact:true}).click();
    await page.getByText("2 items shown",{exact:true}).waitFor();
    await page.getByRole("button",{name:"Reset all filters",exact:true}).click();
    if(viewport.width<760) await page.getByRole("button",{name:"Filters",exact:true}).click();
    await page.getByRole("checkbox",{name:"Select In fairness",exact:true}).check();
    await page.getByRole("button",{name:"Add to Loadout",exact:true}).click();
    await page.waitForURL(/\/loadout\?/);
    await page.getByRole("button",{name:"Remove In fairness from loadout",exact:true}).waitFor();
    await page.goto(`${origin}/corpus`,{waitUntil:"domcontentloaded"});
    await page.getByRole("button",{name:"View In fairness",exact:true}).waitFor();
    await page.evaluate(owner=>window.__setLoadoutUser(owner),loadoutOwner);
    await page.waitForFunction(()=>!document.querySelector('button[aria-label="Edit In fairness"]')?.disabled);
    await page.getByRole("button",{name:"Edit In fairness",exact:true}).click();
    await dialog.getByLabel("Meaning",{exact:true}).fill("Cloud edited meaning");
    failPatch=true;
    await dialog.getByRole("button",{name:"Save changes",exact:true}).click();
    await dialog.getByRole("alert").waitFor();
    assert.equal(await dialog.getByLabel("Meaning",{exact:true}).inputValue(),"Cloud edited meaning");
    await dialog.getByRole("button",{name:"Save changes",exact:true}).click();
    await dialog.getByText("Changes saved.",{exact:true}).waitFor();
    await dialog.getByRole("button",{name:"Close corpus detail"}).click();
    await page.reload({waitUntil:"domcontentloaded"});
    await page.getByText("Cloud edited meaning",{exact:true}).waitFor();
    await page.getByRole("button",{name:"View In fairness",exact:true}).click();
    await dialog.getByRole("button",{name:"Delete item",exact:true}).click();
    await dialog.getByRole("button",{name:"Confirm delete",exact:true}).click();
    await page.getByText("9 items shown",{exact:true}).waitFor();
    await page.reload({waitUntil:"domcontentloaded"}); await page.getByText("9 items shown",{exact:true}).waitFor();
    await page.getByRole("button",{name:`View ${records[0].item.text}`,exact:true}).click();
    await page.evaluate(()=>window.__setLoadoutUser("other-corpus-owner"));
    await page.getByRole("heading",{name:"Your collection starts with one expression."}).waitFor();
    assert.equal(await page.getByRole("dialog").count(),0);
    assert.equal(await page.getByRole("checkbox").count(),0);
    assert.deepEqual(state.errors,[]);
    await context.close(); console.log(`Corpus acceptance passed: ${viewport.width}px`);
  }
} catch (error) {
  for (const context of browser.contexts()) for (const page of context.pages()) {
    await page.screenshot({path:join(artifacts,"failure.png"),fullPage:true}).catch(()=>{});
    console.log("Failure dialog text",await page.getByRole("dialog").allTextContents().catch(()=>[]));
  }
  throw error;
} finally { await browser.close(); console.log(`Screenshots: ${artifacts}`); }
