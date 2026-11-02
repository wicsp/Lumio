import {expect,test} from "bun:test";
import {TitleEditState,TitleValidationError} from "../src/client/title-edit-state.ts";

test("blank title stays editable and never reaches persistence",async()=>{
  let calls=0;const state=new TitleEditState("Original",async title=>{calls++;return title;});
  state.begin();state.draft="  \n ";expect(await state.save()).toBe(false);
  expect(state.error).toBeInstanceOf(TitleValidationError);expect(state.draft).toBe("  \n ");expect(state.editing).toBe(true);expect(calls).toBe(0);
});
test("unchanged normalized title closes without creating a revision",async()=>{
  let calls=0;const state=new TitleEditState("Original",async title=>{calls++;return title;});
  state.begin();state.draft=" Original ";expect(await state.save()).toBe(true);expect(state.editing).toBe(false);expect(calls).toBe(0);
});
test("successful rename uses confirmed value and clears only its own draft",async()=>{
  const state=new TitleEditState("Original",async title=>title.toUpperCase());state.begin();state.draft=" renamed ";
  expect(await state.save()).toBe(true);expect(state.saved).toBe("RENAMED");expect(state.draft).toBe("RENAMED");expect(state.dirty).toBe(false);
});
test("revision conflict preserves the title draft without replay",async()=>{
  let calls=0;const conflict={code:"CONFLICT"};const state=new TitleEditState("Original",async()=>{calls++;throw conflict;});
  state.begin();state.draft="Local draft";expect(await state.save()).toBe(false);
  expect(state.saved).toBe("Original");expect(state.draft).toBe("Local draft");expect(state.editing).toBe(true);expect(state.dirty).toBe(true);expect(state.error).toBe(conflict);expect(calls).toBe(1);
});
test("double submit and cancel during pending save cannot duplicate or discard the request",async()=>{
  let release:(title:string)=>void=()=>{},calls=0;
  const state=new TitleEditState("Original",()=>{calls++;return new Promise(resolve=>{release=resolve;});});
  state.begin();state.draft="Pending";const pending=state.save();expect(state.saving).toBe(true);
  expect(await state.save()).toBe(false);state.cancel();expect(state.draft).toBe("Pending");expect(state.editing).toBe(true);
  release("Pending");expect(await pending).toBe(true);expect(calls).toBe(1);expect(state.saving).toBe(false);
});
test("cancel discards the draft without persisting it",()=>{
  const state=new TitleEditState("Original",async()=>{throw new Error("must not persist");});state.begin();state.draft="Discard";state.cancel();
  expect(state.saved).toBe("Original");expect(state.draft).toBe("Original");expect(state.dirty).toBe(false);expect(state.editing).toBe(false);
});
