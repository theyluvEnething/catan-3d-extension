// One-time interactive login: opens Colonist in the dedicated profile and waits for you to
// log in manually, then persists the session into ./.colonist-profile. Run this ONCE.
//
//   node harness/login-once.js
//
// A Chrome window opens on colonist.io. Log in (Google / email / however you normally do).
// Once you see yourself logged in, come back here and press Enter in the terminal.
import { launch, checkLogin } from "./launch.js";
import readline from "node:readline";

const context = await launch({ withExtension: false });
const page = context.pages()[0] || (await context.newPage());
await page.goto("https://colonist.io/", { waitUntil: "domcontentloaded" });

console.log("\n=== A Chrome window is open on colonist.io ===");
console.log("Log in there manually. When you are logged in, press Enter here to save.\n");

await new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question("Press Enter once logged in... ", () => {
    rl.close();
    resolve();
  });
});

const { loggedIn, evidence } = await checkLogin(page);
console.log("LOGIN_RESULT", JSON.stringify({ loggedIn, evidence }, null, 2));
console.log(loggedIn ? "\n✅ Session saved into .colonist-profile" : "\n⚠️ Still looks logged out — try again.");
await context.close();
