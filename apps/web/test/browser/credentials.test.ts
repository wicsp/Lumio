import {expect,test} from "bun:test";
import {LoginStorage} from "../../src/client/credentials.ts";
class MemoryStorage {
  values=new Map<string,string>();
  getItem(key:string){return this.values.get(key)??null;}
  setItem(key:string,value:string){this.values.set(key,value);}
  removeItem(key:string){this.values.delete(key);}
}
const hub="http://127.0.0.1:7420";
const denied=()=>{throw new Error("storage disabled");};
function stores(){const tab=new MemoryStorage(),device=new MemoryStorage();return {tab,device,login:new LoginStorage(hub,()=>tab,()=>device)};}

test("refresh restores tab login without remembering the device",()=>{
 const {tab,device,login}=stores();expect(login.save("synthetic-token",false)).toBe("tab");
 expect(new LoginStorage(hub,()=>tab,()=>device).load()).toEqual({token:"synthetic-token",remember:false});
 expect(new LoginStorage(hub,()=>new MemoryStorage(),()=>device).load()).toBeUndefined();expect(device.values.size).toBe(0);
});
test("remembered login survives a new tab, logout removes only Lumio's own key",()=>{
 const {tab,device,login}=stores();device.setItem("unrelated-extension-key","keep");
 expect(login.save("synthetic-token",true)).toBe("device");expect(tab.values.size).toBe(0);
 const reopened=new LoginStorage(hub,()=>new MemoryStorage(),()=>device);expect(reopened.load()).toEqual({token:"synthetic-token",remember:true});
 reopened.clear();expect(reopened.load()).toBeUndefined();expect(device.getItem("unrelated-extension-key")).toBe("keep");
});
test("choosing a temporary login removes the previous remembered account",()=>{
 const {device,login}=stores();login.save("previous-token",true);login.save("temporary-token",false);
 expect(login.load()).toEqual({token:"temporary-token",remember:false});expect(device.getItem(login.key)).toBeNull();
});
test("late invalidation of a different token cannot erase its replacement",()=>{
 const {login}=stores();login.save("replacement-token",true);login.clear("previous-token");expect(login.load()?.token).toBe("replacement-token");
 login.clear("replacement-token");expect(login.load()).toBeUndefined();
});
test("changing the upstream Hub never loads or clears the first Hub's credential",()=>{
 const {tab,device,login}=stores();login.save("hub-one-token",true);
 const other=new LoginStorage("https://other-hub.example",()=>tab,()=>device);expect(other.load()).toBeUndefined();other.save("hub-two-token",true);other.clear();expect(login.load()?.token).toBe("hub-one-token");
});
test("malformed, blank, wrong-version and wrong-Hub records cannot become credentials",()=>{
 const {tab,login}=stores();for(const value of ["bad json","null",JSON.stringify({version:2,hub,token:"x"}),JSON.stringify({version:1,hub,token:"   "}),JSON.stringify({version:1,hub:"https://other.example",token:"x"})]){tab.setItem(login.key,value);expect(login.load()).toBeUndefined();}
});
test("blocked device storage falls back to the tab and reports the actual scope",()=>{
 const tab=new MemoryStorage();const login=new LoginStorage(hub,()=>tab,denied);expect(login.save("synthetic-token",true)).toBe("tab");expect(login.load()).toEqual({token:"synthetic-token",remember:false});
});
test("all storage blocked still permits memory-only login without throwing",()=>{
 const login=new LoginStorage(hub,denied,denied);expect(login.load()).toBeUndefined();expect(login.save("synthetic-token",true)).toBe("memory");expect(()=>login.clear()).not.toThrow();
});
test("a broken temporary store does not hide an accessible remembered login",()=>{
 const device=new MemoryStorage();const login=new LoginStorage(hub,denied,()=>device);login.save("synthetic-token",true);expect(login.load()).toEqual({token:"synthetic-token",remember:true});
});
