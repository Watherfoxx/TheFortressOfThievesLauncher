package com.thefortressofthieves.launcher.anticheat;

/**
 * Example launcher bootstrap showing anti-cheat monitor startup.
 */
public final class LauncherMain {
    private LauncherMain() {
    }

    /**
     * Example entry point.
     *
     * @param args launcher arguments.
     */
    public static void main(String[] args) {
        AntiCheatMonitor.start();

        // Continue with the launcher or Minecraft bootstrap startup flow.
        System.out.println("Launcher started with anti-cheat monitor enabled.");
    }
}
