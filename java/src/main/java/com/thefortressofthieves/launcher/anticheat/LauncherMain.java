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
        for (String propertyKey : new String[]{"launcher.username", "launcher.pseudo", "username", "pseudo"}) {
            String configured = System.getProperty(propertyKey, "").trim();
            if (!configured.isEmpty()) {
                return configured;
            }
        }

        for (int i = 0; i < args.length; i++) {
            String normalized = args[i].toLowerCase(Locale.ROOT);

            if (normalized.startsWith("--username=") || normalized.startsWith("--pseudo=")) {
                int separatorIndex = args[i].indexOf('=');
                if (separatorIndex >= 0 && separatorIndex + 1 < args[i].length()) {
                    return args[i].substring(separatorIndex + 1).trim();
                }
            }

            if (("--username".equals(normalized) || "--pseudo".equals(normalized)) && i + 1 < args.length) {
                return args[i + 1].trim();
            }
        }

        return "";
    }
}
