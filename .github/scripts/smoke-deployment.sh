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
sitemap=$(get /sitemap.xml)
robots=$(get /robots.txt)
analytics=$(get /landing-analytics.js)

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
grep -Fq 'location.hostname' <<< "$bundle"
grep -Fq 'name="robots" content="noindex"' <<< "$app"
grep -Fq 'name="google-site-verification"' <<< "$english"
grep -Fq 'name="msvalidate.01"' <<< "$english"
grep -Fq 'src="/landing-analytics.js"' <<< "$english"
grep -Fq 'src="/landing-analytics.js"' <<< "$chinese"
grep -Fq 'www.googletagmanager.com/gtag/js' <<< "$analytics"
if grep -Fq 'landing-analytics.js' <<< "$app$worker"; then
  exit 1
fi
grep -Fq "rel=\"canonical\" href=\"https://$PRODUCTION_HOSTNAME/\"" <<< "$english"
grep -Fq "rel=\"canonical\" href=\"https://$PRODUCTION_HOSTNAME/zh/\"" <<< "$chinese"
grep -Fq "<loc>https://$PRODUCTION_HOSTNAME/</loc>" <<< "$sitemap"
grep -Fq "<loc>https://$PRODUCTION_HOSTNAME/zh/</loc>" <<< "$sitemap"
grep -Fq "Sitemap: https://$PRODUCTION_HOSTNAME/sitemap.xml" <<< "$robots"

if [[ "$mode" == public ]]; then
  legacy=https://secure-notes-waynegongcn.vercel.app
  for path in / /zh/; do
    result=$(curl --fail --silent --show-error --max-time 30 --output /dev/null \
      --write-out '%{http_code} %{redirect_url}' "$legacy$path")
    [[ "$result" == "308 $url$path" ]]
  done
  legacy_app=$(curl --fail --silent --show-error --max-time 30 "$legacy/app/")
  grep -Fq 'id="root"' <<< "$legacy_app"
fi

printf 'Verified landing pages, app bundle, RP ID and PWA at %s\n' "$url"
