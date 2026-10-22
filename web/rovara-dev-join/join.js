// rovara.dev/join: forwards an invite link to the join page of the Rovara cell that issued it.
//
// The invite travels in the URL fragment (https://rovara.dev/join#invite=<token>), which a browser never sends to the server that hosts
// this page. This script takes the invite out of the address bar before it does anything else, checks that it has the shape of an
// invite, reads which cell to forward to from cell.json on this same origin, and sends the browser there. It reads nothing else from
// the address, stores nothing, and writes text only (never markup).
(function () {
  "use strict";

  var INVITE = /^[A-Za-z0-9_-]{43}$/;
  var NOT_VALID = "This invite link isn't valid";
  var NOT_REACHABLE = "Rovara is not reachable from this link right now. Try again later.";

  /** The invite in the fragment (#invite=<token>), or, for links issued before this page existed, in the query (?invite=<token>). */
  function readInvite() {
    var fromHash = new URLSearchParams(String(location.hash).replace(/^#/, "")).get("invite");
    if (fromHash !== null) return fromHash;
    return new URLSearchParams(String(location.search).replace(/^\?/, "")).get("invite");
  }

  function show(text) {
    var message = document.getElementById("message");
    if (message !== null) message.textContent = text;
  }

  /** The cell's base URL when cell.json names one safely: an https URL with no query, hash or password. Otherwise null. */
  function cellBase(body) {
    if (typeof body !== "object" || body === null || typeof body.cellUrl !== "string") return null;
    var text = body.cellUrl;
    if (/[?#]/.test(text)) return null;
    var url;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
    return url.origin + url.pathname.replace(/\/+$/, "");
  }

  // First: read the invite, then take it (and anything else) out of the address bar and the history entry.
  var invite = readInvite();
  try {
    history.replaceState(null, "", location.pathname);
  } catch {
    // A browser that will not rewrite the address still gets the invite checked below; nothing here depends on it.
  }

  if (invite === null || !INVITE.test(invite)) {
    show(NOT_VALID);
    return;
  }

  fetch("./cell.json", { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" })
    .then(function (response) {
      if (!response.ok) throw new Error("cell.json " + response.status);
      return response.json();
    })
    .then(function (body) {
      var base = cellBase(body);
      if (base === null) {
        show(NOT_REACHABLE);
        return;
      }
      location.replace(base + "/v1/auth/join?invite=" + invite);
    })
    .catch(function () {
      show(NOT_REACHABLE);
    });
})();
