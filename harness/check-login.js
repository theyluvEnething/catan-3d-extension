// Launches Chrome with the dedicated profile and reports whether Colonist is logged in.
import { launch, checkLogin, SHOTS_DIR } from "./launch.js";
import path from "node:path";

const context = await launch({ withExtension: false });
const page = context.pages()[0] || (await context.newPage());

try {
  const { loggedIn, evidence } = await checkLogin(page);
  console.log("LOGIN_RESULT", JSON.stringify({ loggedIn, evidence }, null, 2));
  await page.screenshot({ path: path.join(SHOTS_DIR, "login-check.png") });
  console.log("SCREENSHOT", path.join(SHOTS_DIR, "login-check.png"));
} catch (e) {
  console.error("ERROR", e);
} finally {
  await context.close();
}
