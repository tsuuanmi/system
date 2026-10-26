---
"@tsuuanmi/system-browser-patchright": patch
"@tsuuanmi/system-display-virtual": patch
"@tsuuanmi/system-provider-chatgpt-web": patch
"@tsuuanmi/system-turns": patch
"@tsuuanmi/system-ui-ops": patch
---

Clean-up of the website and browser side (T244): exports no other module imports are module-private again. browser-patchright's entry no longer re-exports the Chrome-lock internals and the storage-state conversion, ui-ops' no longer re-exports the heal matcher and locator internals, display-virtual's no longer re-exports the Xvfb screen size, and provider-chatgpt-web no longer re-exports provider-core's driver types. Behaviour is unchanged.
