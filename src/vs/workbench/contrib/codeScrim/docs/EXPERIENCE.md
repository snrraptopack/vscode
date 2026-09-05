# CodeScrim entry and learner experience

CodeScrim opens with a quiet Home screen offering Learn and Record. Learn opens
a local `.scrim` through the existing verified package reader, then enters the
native lesson. A file may also be dropped onto the Learn page. Record restores
the author workspace without starting capture. The title-bar Home action returns
to the entry screen. Restored lessons keep their existing entry behavior.

The learner editor is the primary surface. Course/files and transcript/notes
rails start collapsed and can be revealed independently. The playback dock has
a bounded, centered width, with reserved space beneath the editor; Restart is
available in Playback Options. Playback remains at its existing normal speed.

Learner browser replay is a floating surface inside the workbench, never an editor
tab or a separate OS window. It can be moved, resized, expanded, and hidden.
The top bar is a drag handle; arrow keys on it and the Resize control provide
keyboard equivalents. Bounds are remembered in profile storage and clamped to
the workbench, so the browser can extend over the terminal. Expansion uses the
available workbench height while leaving the title bar reachable. Dismissal persists across
subsequent snapshots until the learner reopens the browser; no replay event
changes OS-window focus.

The address identifies the recorded page. A compact tab selector appears in the
top bar only when multiple recorded tabs exist, using the existing timeline
navigation service. Opening the browser without a snapshot shows an empty state.
This is passive
DOM replay: moving the surface inside the lesson does not introduce page-script
execution or live web navigation.

The author browser remains a native auxiliary window. It offers back/forward,
reload, an address/search field using the configured integrated-browser search
engine, new/close tab controls, and Developer Tools. Ctrl/Cmd+L focuses the
address. Background title/loading updates do not overwrite an address being
edited.

URLs for opening scrims, playlists, a richer lesson library, and live learner
browser execution are later work.
