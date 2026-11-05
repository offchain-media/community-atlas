/* Theme switch for the static pages (event pages). The map page uses app.js. */
const root = document.documentElement;
const dark = () => root.dataset.theme === "dark" || (!root.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
try {
  const saved = localStorage.getItem("atlas-theme");
  if (saved === "dark" || saved === "light") root.dataset.theme = saved;
} catch {}
document.querySelector("[data-theme-toggle]")?.addEventListener("click", () => {
  root.dataset.theme = dark() ? "light" : "dark";
  try {
    localStorage.setItem("atlas-theme", root.dataset.theme);
  } catch {}
});
