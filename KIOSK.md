# Running the check-in kiosk on the touch monitor

The kiosk screen (`/?v=scanin`) locks itself down as far as a web page can:
back/forward is blocked, right-click and long-press menus are off, browser
shortcuts (Cmd+L, Cmd+R, Cmd+T, Cmd+N…) do nothing, and the mouse pointer is
hidden on that screen.

**Staff panel:** press and hold the "Flag Football · Find my team" title for
3 seconds. From there you can set which **league, division and week** this
kiosk uses (saved on this device only, so two kiosks at two fields can differ),
or **Exit kiosk → Stations**. Week defaults to "Same as Team Board".

## Full lockdown: Chrome kiosk mode

A web page can't stop someone quitting the browser or switching apps. Chrome's
kiosk mode removes the address bar, tabs and window controls entirely:

```bash
open -na "Google Chrome" --args --kiosk --user-data-dir="$HOME/.ff-kiosk-chrome" --window-position=0,0 --no-first-run --disable-pinch --overscroll-history-navigation=0 "http://localhost:3000/?v=scanin"
```

- `--user-data-dir` gives the kiosk its own Chrome profile, so it never touches
  your normal browser windows. Sign in once in that window; the session lasts.
- `--window-position=0,0` puts it on the **main** display. On this Mac the Acer
  PM161QT is set as main, so 0,0 is the touch monitor. If the main display
  changes, use the Acer's position from System Settings → Displays.
- `--disable-pinch` and `--overscroll-history-navigation=0` turn off pinch-zoom
  and swipe-back gestures.
- To close it: Cmd+Q while that window is in front.

## About the cursor

macOS has **one** pointer for all screens. Touching the touch monitor moves
that pointer to the touch monitor — there's no setting that gives each screen
its own cursor. The kiosk hides the pointer so nobody sees it, but if someone
is using the main screen at the same moment, a touch on the kiosk will yank
their cursor over.

The clean fix is to run the kiosk from its own small computer (an old laptop,
a Chromebook, or a mini PC) plugged into the touch monitor, pointed at this
app over the network. Then the two screens are fully independent.
