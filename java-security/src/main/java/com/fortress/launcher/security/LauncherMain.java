package com.fortress.launcher.security;

import java.net.URI;
import java.nio.file.Path;

/**
 * Example integration point in launcher startup flow.
 */
public class LauncherMain {

    private static final URI SECURITY_WEBHOOK = URI.create("https://discord.com/api/webhooks/1479979837920645391/gk-m5A21RWsqS5xR4y1DZgJJmrp-X8bKE8u6_Swc8O1ZPhRvq9uuhYvt8mbgxk910qkw");

    public static void main(String[] args) throws Exception {
        SecurityMonitor monitor = SecurityMonitor.defaultMonitor(
                Path.of("logs", "security.log"),
                SECURITY_WEBHOOK,
                true
        );

        SecurityReport report = monitor.runInitialScan();
        if (!report.isClean()) {
            // Silent block: do not reveal anti-cheat detection details to the client.
            return;
        }

        launchMinecraft();
        monitor.startBackgroundMonitoring();
    }

    private static void launchMinecraft() {
        // Hook your existing launch sequence here.
    }
}
