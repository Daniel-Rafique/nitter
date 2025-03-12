# SPDX-License-Identifier: AGPL-3.0-only
import os, strformat
import karax/[karaxdsl, vdom]

var aboutHtml: string

proc initAboutPage*(dir: string) =
  try:
    aboutHtml = readFile(dir/"md/about.html")
  except IOError:
    stderr.write (dir/"md/about.html") & " not found, please check the file\n"
    aboutHtml = "<h1>About page is missing</h1><br><br>"

proc renderAbout*(): VNode =
  buildHtml(tdiv(class="overlay-panel about-panel")):
    verbatim aboutHtml
    tdiv(class="koynlabs-footer"):
      h3: text "Koynlabs - Crypto Intelligence Platform"
      p: 
        text "© 2024 Koynlabs. All rights reserved. "
        a(href="https://koyn.ai"): text "Visit our website"
