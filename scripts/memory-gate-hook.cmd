@echo off
rem The memory check's hook on Windows (main/memory-gate-hook.mts), run on the
rem app's own binary as a node. The app names both in the worker's environment;
rem without them there is nothing to ask, so the command runs.
setlocal DisableDelayedExpansion
if not defined AGENTBOX_GATE_RUNTIME exit /b 0
if not defined AGENTBOX_GATE_HOOK exit /b 0
set ELECTRON_RUN_AS_NODE=1
"%AGENTBOX_GATE_RUNTIME%" %AGENTBOX_GATE_FLAGS% "%AGENTBOX_GATE_HOOK%" %1
rem Like the .sh, the hook never fails the command: a broken check lets it run.
exit /b 0
