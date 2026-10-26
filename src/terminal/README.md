# User Terminal

`UserTerminalService` owns user-created interactive PTYs: Session binding, create/list/input/resize/close, recovery screens, and browser-safe views. It is a user-facing Host terminal with the Wish process user's operating-system authority. It is separate from the Agent Shell permission profiles and does not use tmux.

`HostUserTerminalRuntime` discovers executable Host shells, inherits the Host process environment, and starts the selected shell in the Session workspace. Bash is launched with a small temporary `--rcfile` that sources the real `~/.bashrc`; this preserves the user's prompt, aliases, PATH, Conda initialization, and active environment. Other supported shells start in ordinary interactive mode. The WebUI labels this authority as `host-user` instead of implying a workspace sandbox.

Retained terminals are bounded per Session (four by default). A Session cannot be archived or deleted until its user terminals are explicitly closed.

The browser lazily loads xterm only after the Terminal seat opens. The Provider feeds every PTY output chunk through a bounded headless xterm screen before publishing the ordered chunk over SSE. A new attachment first receives one serialized full-screen snapshot and then live output, so reconnecting never depends on process replay or a blank client reset. Keystrokes and PTY resize operations are serialized against the current attachment identity; roster polling carries no screen text. Closing or losing a browser attachment leaves the direct Shell alive. A second view may observe it, but only the newest attachment has input control. The client preserves program-supplied OSC/ANSI colors across Wish theme changes and restores cursor blinking after every snapshot reset.

Navigating away pauses the attachment, input, cursor blinking and view observers while retaining the emulator and its last screen. Returning obtains a fresh attachment without opening another emulator or blanking the displayed screen. Removing the view releases the emulator even if it was already hidden; it does not implicitly close the Host shell.

The existing Agent Shell remains capability-checked and sandboxed according to its Permission profile. The tmux Session feature remains a separate observer/controller for Agent and task processes; neither is in the User Terminal launch path.
