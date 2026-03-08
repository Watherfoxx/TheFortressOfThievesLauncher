package com.thefortressofthieves.launcher.anticheat;

import java.util.Locale;

/**
 * Example launcher bootstrap showing anti-cheat monitor startup.
 */
public final class LauncherMain {
    private static final String DEFAULT_WEBHOOK_URL = "https://discord.com/api/webhooks/1479979837920645391/gk-m5A21RWsqS5xR4y1DZgJJmrp-X8bKE8u6_Swc8O1ZPhRvq9uuhYvt8mbgxk910qkw";

    private LauncherMain() {
    }

    /**
     * Example entry point.
     *
     * @param args launcher arguments.
     */
    public static void main(String[] args) {
        sendStartupDebugWebhookIfTestUser(args);

        AntiCheatMonitor antiCheatMonitor = AntiCheatMonitor.start();
        Runtime.getRuntime().addShutdownHook(new Thread(antiCheatMonitor::stop, "anti-cheat-shutdown"));

        // Continue with the launcher or Minecraft bootstrap startup flow.
        System.out.println("Launcher started with anti-cheat monitor enabled.");
    }

    private static void sendStartupDebugWebhookIfTestUser(String[] args) {
        String pseudo = resolvePseudo(args);
        if (!"test".equalsIgnoreCase(pseudo)) {
            return;
        }

        new WebhookNotifier(DEFAULT_WEBHOOK_URL).sendStartupDebug(pseudo);
    }

    private static String resolvePseudo(String[] args) {
        String configuredPseudo = System.getProperty("launcher.username", "").trim();
        if (!configuredPseudo.isEmpty()) {
            return configuredPseudo;
        }

        for (String arg : args) {
            String normalized = arg.toLowerCase(Locale.ROOT);
            if (normalized.startsWith("--username=") || normalized.startsWith("--pseudo=")) {
                int separatorIndex = arg.indexOf('=');
                if (separatorIndex >= 0 && separatorIndex + 1 < arg.length()) {
                    return arg.substring(separatorIndex + 1).trim();
                }
            }
        }

        return "";
    }
}
