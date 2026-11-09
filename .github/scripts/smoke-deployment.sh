#!/usr/bin/env bash
set -euo pipefail
trap 'echo "Deployment check failed at line $LINENO for $url" >&2' ERR

url=$1
mode=$2
[[ "$mode" == staged || "$mode" == public ]]

get() {
  if [[ "$mode" == staged ]]; then
    vercel curl "$1" --deployment "$url" -- --fail --silent --show-error --max-time 30
  else
    curl --fail --silent --show-error --max-time 30 "$url$1"
  fi
}

english=$(get /)
chinese=$(get /zh/)
app=$(get /app/)
styles=$(get /landing.css)
worker=$(get /app/sw.js)
manifest=$(get /manifest.webmanifest)

grep -Fq '<html lang="en">' <<< "$english"
grep -Fq '<html lang="zh-CN">' <<< "$chinese"
grep -Fq 'href="/app/"' <<< "$english"
grep -Fq 'href="/app/"' <<< "$chinese"
grep -Fq 'id="root"' <<< "$app"
grep -Fq -- '--pine:' <<< "$styles"
grep -Fq 'const ASSETS=["/app/"' <<< "$worker"
jq -e '.scope == "/app/" and .start_url == "/app/"' <<< "$manifest" > /dev/null

bundle_path=$(sed -nE 's@.*<script[^>]+src="(/assets/[^"]+\.js)".*@\1@p' <<< "$app")
[[ -n "$bundle_path" ]]
bundle=$(get "$bundle_path")
grep -Fq "$PRODUCTION_HOSTNAME" <<< "$bundle"

printf 'Verified landing pages, app bundle, RP ID and PWA at %s\n' "$url"
