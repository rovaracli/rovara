(function () {
 "use strict";
 function unavailable() { var message = document.getElementById("message"); if (message) message.textContent = "Rovara is not reachable from this link right now. Try again later."; }
 fetch("./cell.json", { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" }).then(function (response) {
  if (!response.ok) throw new Error("Cell configuration unavailable"); return response.json();
 }).then(function (body) {
  if (typeof body !== "object" || body === null || typeof body.cellUrl !== "string" || /[?#\\\s]/.test(body.cellUrl)) { unavailable(); return; }
  var url; try { url = new URL(body.cellUrl); } catch { unavailable(); return; }
  if (url.protocol !== "https:" || url.username || url.password) { unavailable(); return; }
  location.replace(url.origin + url.pathname.replace(/\/+$/, "") + "/app/signup");
 }).catch(unavailable);
})();
