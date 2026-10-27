// Copies the Microsoft sign-in library into public/vendor so the site serves it itself.
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
const src = "node_modules/@azure/msal-browser/lib/msal-browser.min.js";
if (!existsSync(src)) {
  console.error(`Could not find ${src}. Run "npm install" first.`);
  process.exit(1);
}
mkdirSync("public/vendor", { recursive: true });
copyFileSync(src, "public/vendor/msal-browser.min.js");
console.log("Copied msal-browser to public/vendor");
