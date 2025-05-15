#!/usr/bin/env bash

set -e

npm install

vsce package
code --install-extension vscode-powertools-0.67.5.vsix
