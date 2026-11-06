import {test,expect} from "bun:test";
import {matchTerms,matchRanges} from "../src/client/note-matches.ts";
const marked=(text:string,terms:string[])=>matchRanges(text,terms).map(([a,b])=>text.slice(a,b));
test("highlights titles, body-only matches, repeated words and overlapping Chinese terms",()=>{
  expect(marked("Retrieval memory and retrieval",matchTerms("retrieval"))).toEqual(["Retrieval","retrieval"]);
  expect(marked("An unrelated title",matchTerms("xylophone"))).toEqual([]);
  expect(marked("The xylophone passage",matchTerms("xylophone"))).toEqual(["xylophone"]);
  expect(marked("知识检索与知识管理",matchTerms("知识检索"))).toEqual(["知识检索","知识"]);
  expect(matchTerms("trial中文")).toEqual(["trial","中文"]);
});
test("normalization maps back to original Unicode without splitting graphemes or emoji",()=>{
  expect(marked("😀 ＡＩ ﬁle cafe\u0301",matchTerms("ai file café"))).toEqual(["ＡＩ","ﬁle","cafe\u0301"]);
  expect(matchRanges("😀 中文",matchTerms("中文"))).toEqual([[3,5]]);
  expect(marked("retrieval evidence",matchTerms("retrievel"))).toEqual(["retrieval"]);
});
test("context excludes templates, code, unfinished queries and footnotes; empty searches have no marks",()=>{
  const terms=matchTerms({title:"Research",focus:"Memory 【【xylophone",text:"## Template\n```ts\nsecret\n```\n[^a]: [[Source]]"});
  expect(terms).toContain("memory");for(const word of ["template","secret","xylophone","source"])expect(terms).not.toContain(word);
  expect(matchRanges("Anything",matchTerms(""))).toEqual([]);
  expect(marked("<img src=x> [a+]",["<img","[a+]"])).toEqual(["<img","[a+]"]);
});
