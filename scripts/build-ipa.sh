#!/bin/zsh
set -euo pipefail
cd "${0:A:h:h}"
xcodegen generate
mkdir -p build
xcodebuild -project OxasLibrary.xcodeproj -scheme OxasLibrary -configuration Release -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath build/DerivedData -clonedSourcePackagesDirPath build/SourcePackages CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build > build/device-build.log 2>&1
stage=$(mktemp -d "${TMPDIR%/}/oxa-package.XXXXXX")
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/Payload"
ditto build/DerivedData/Build/Products/Release-iphoneos/OxasLibrary.app "$stage/Payload/OxasLibrary.app"
# Device binaries built with signing disabled contain no provisioning profile.
(cd "$stage" && /usr/bin/zip -qry "$stage/library.ipa" Payload)
mv "$stage/library.ipa" build/Oxas-Library-unsigned.ipa
unzip -t build/Oxas-Library-unsigned.ipa
file build/DerivedData/Build/Products/Release-iphoneos/OxasLibrary.app/OxasLibrary
