package com.thefortressofthieves.launcher.anticheat;

import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.URL;
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
     *
     * @param processes suspicious processes.
     * @param classes suspicious classes.
     * @throws IOException if the HTTP request fails.
     */
    public void sendAlert(List<String> processes, List<String> classes) throws IOException {
        String content = buildContent(processes, classes);
        String payload = "{\"content\":\"" + escapeJson(content) + "\"}";

        HttpURLConnection connection = null;
        try {
            URL url = new URL(webhookUrl);
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");

            byte[] payloadBytes = payload.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(payloadBytes.length);

            try (OutputStream outputStream = connection.getOutputStream()) {
                outputStream.write(payloadBytes);
            }

            int responseCode = connection.getResponseCode();
            if (responseCode < 200 || responseCode >= 300) {
                throw new IOException("Webhook request failed with HTTP status " + responseCode);
            }
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private String buildContent(List<String> processes, List<String> classes) {
        String timestamp = Instant.now().toString();
        String user = System.getProperty("user.name", "unknown");
        String host = resolveHostName();

        StringBuilder sb = new StringBuilder();
        sb.append("[ANTI-CHEAT ALERT]\n\n");
        sb.append("Suspicious activity detected.\n\n");

        sb.append("Processes:\n");
        if (processes.isEmpty()) {
            sb.append("- none\n");
        } else {
            processes.forEach(p -> sb.append("- ").append(p).append("\n"));
        }

        sb.append("\nClasses:\n");
        if (classes.isEmpty()) {
            sb.append("- none\n");
        } else {
            classes.forEach(c -> sb.append("- ").append(c).append("\n"));
        }

        sb.append("\nTimestamp: ").append(timestamp).append("\n");
        sb.append("Username: ").append(user).append("\n");
        sb.append("Hostname: ").append(host);
        return sb.toString();
    }

    private String resolveHostName() {
        try {
            return InetAddress.getLocalHost().getHostName();
        } catch (IOException e) {
            return "unknown";
        }
    }

    private String escapeJson(String input) {
        return input
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r");
    }
}
