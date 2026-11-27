# Test signing key

`debug.keystore` signs the **test builds** that CI makes (`.github/workflows/build-apk.yml`).
Android only installs an update over an app signed with the same key, and every CI machine would
otherwise create a new random debug key — so this one is fixed and committed.

It is a standard Android debug keystore (alias `androiddebugkey`, passwords `android`) and is
**not secret**: anyone can build an APK that updates these test builds. That's fine for testing,
but never use it for builds shared publicly. Release builds will get their own key, kept as a
GitHub secret.
