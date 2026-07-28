# Vendored third-party code — attribution and licenses

## Voyager (MineDojo/Voyager)

The `primitives/` and `library/` modules in this directory are TypeScript ports
of code published in https://github.com/MineDojo/Voyager (control primitives in
`voyager/control_primitives/`, generated skills in `skill_library/trial1-3/`),
released under the MIT License:

```
MIT License

Copyright (c) 2023 MineDojo Team

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Ports are substantial rewrites (typed, deps-injected, 1.21.6 name guards,
closed failure vocabulary) rather than verbatim copies; attribution retained
per the license. Voyager targeted MC ~1.19 / mineflayer ^4.8.1 — see
`names.ts` for the drift handling.

## mineflayer plugins (npm, all MIT)

| Package | Pin | Upstream |
|---|---|---|
| mineflayer-pathfinder | 2.4.5 | PrismarineJS/mineflayer-pathfinder |
| mineflayer-collectblock | 1.6.0 | PrismarineJS/mineflayer-collectblock |
| mineflayer-tool | 1.2.0 | PrismarineJS/mineflayer-tool |
| mineflayer-pvp | 1.3.2 | PrismarineJS/mineflayer-pvp |
| mineflayer-auto-eat | 3.3.6 | linkle69/mineflayer-auto-eat (last CommonJS release; >=4 is ESM-only) |
| mineflayer-armor-manager | 2.0.1 | PrismarineJS/MineflayerArmorManager |

Root `package.json` carries an `overrides` entry forcing mineflayer-pvp's
transitive `mineflayer-utils` onto the workspace mineflayer 4.37.1 (upstream
declares `mineflayer ^2.27.0`, which would nest a second ancient tree).
Verify with `npm ls mineflayer` after any dependency change: exactly one
mineflayer@4.37.1 must appear.
