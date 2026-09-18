#!/bin/sh
# Installed at Contents/Resources/cli/bin/uebox. No external Node installation needed.
set -eu
launcher=$0
while [ -L "$launcher" ]; do
  base=$(CDPATH= cd -- "$(dirname -- "$launcher")" && pwd -P)
  link=$(readlink "$launcher")
  case "$link" in
    /*) launcher=$link ;;
    *) launcher=$base/$link ;;
  esac
done
base=$(CDPATH= cd -- "$(dirname -- "$launcher")" && pwd -P)
contents=$(CDPATH= cd -- "$base/../../.." && pwd -P)
executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$contents/Info.plist")
export ELECTRON_RUN_AS_NODE=1
exec "$contents/MacOS/$executable" "$contents/Resources/cli/index.js" "$@"
