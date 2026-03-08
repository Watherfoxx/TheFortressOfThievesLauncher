package com.thefortressofthieves.launcher.anticheat;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;

/**
 * Sends anti-cheat alerts to a Discord webhook.
 */
public class WebhookNotifier {
    private final String webhookUrl;

    /**
     * Creates a notifier for a Discord webhook URL.
     *
     * @param webhookUrl Discord webhook URL.
     */
    public WebhookNotifier(String webhookUrl) {
        this.webhookUrl = webhookUrl;
    }

    /**
     * Sends an anti-cheat report to Discord.
     * Never throws so anti-cheat checks cannot crash the launcher.
     *
     * @param suspiciousClasses suspicious classes.
     * @param suspiciousThreads suspicious threads.
     * @return webhook response code, or -1 on failure.
     */
    public int sendAlert(List<String> suspiciousClasses, List<String> suspiciousThreads) {
        return postContent(buildDetectionContent(suspiciousClasses, suspiciousThreads));
    }

    /**
     * Sends a debug startup message for test users.
     * Never throws so launcher startup is never interrupted.
     *
     * @param pseudo player pseudo.
     * @return webhook response code, or -1 on failure.
     */
    public int sendStartupDebug(String pseudo) {
        String content = "ANTI CHEAT DEBUG\\n\\n"
            + "Launcher startup webhook triggered for pseudo: " + pseudo + "\\n"
            + "Timestamp: " + Instant.now();
        return postContent(content);
    }

    private int postContent(String content) {
        String payload = "{\"content\":\"" + escapeJson(content) + "\"}";

        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) java.net.URI.create(webhookUrl).toURL().openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(5000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");

            byte[] payloadBytes = payload.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(payloadBytes.length);

            try (OutputStream outputStream = connection.getOutputStream()) {
                outputStream.write(payloadBytes);
            }

            return connection.getResponseCode();
        } catch (Exception ignored) {
            return -1;
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private String buildDetectionContent(List<String> classes, List<String> threads) {
        StringBuilder sb = new StringBuilder();
        sb.append("ANTI CHEAT ALERT\n\n");
        sb.append("Suspicious injected classes detected.\n\n");

        sb.append("Classes:\n");
        if (classes.isEmpty()) {
            sb.append("- none\n");
        } else {
            classes.forEach(c -> sb.append("- ").append(c).append("\n"));
        }

        sb.append("\nThreads:\n");
        if (threads.isEmpty()) {
            sb.append("- none\n");
        } else {
            threads.forEach(t -> sb.append("- \"").append(t).append("\"\n"));
        }

        sb.append("\nTimestamp: ").append(Instant.now());
        return sb.toString();
    }

    private String escapeJson(String input) {
        return input
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r");
    }
}
