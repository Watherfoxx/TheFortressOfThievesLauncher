package com.fortress.launcher.security;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.logging.FileHandler;
import java.util.logging.Formatter;
import java.util.logging.Level;
import java.util.logging.LogRecord;
import java.util.logging.Logger;

/**
 * Orchestrates initial and periodic anti-cheat scans.
 */
public class SecurityMonitor {

    private final ProcessScanner processScanner;
    private final WindowsModuleScanner windowsModuleScanner;
    private final JvmArgumentScanner jvmArgumentScanner;
    private final Logger logger;
    private final URI webhookUri;
    private final HttpClient httpClient;
    private final ScheduledExecutorService scheduler;
    private final boolean terminateOnDetection;
    private final Runnable terminationAction;

    public SecurityMonitor(
            ProcessScanner processScanner,
            WindowsModuleScanner windowsModuleScanner,
            JvmArgumentScanner jvmArgumentScanner,
            Logger logger,
            URI webhookUri,
            HttpClient httpClient,
            ScheduledExecutorService scheduler,
            boolean terminateOnDetection,
            Runnable terminationAction
    ) {
        this.processScanner = Objects.requireNonNull(processScanner);
        this.windowsModuleScanner = Objects.requireNonNull(windowsModuleScanner);
        this.jvmArgumentScanner = Objects.requireNonNull(jvmArgumentScanner);
        this.logger = Objects.requireNonNull(logger);
        this.webhookUri = Objects.requireNonNull(webhookUri);
        this.httpClient = Objects.requireNonNull(httpClient);
        this.scheduler = Objects.requireNonNull(scheduler);
        this.terminateOnDetection = terminateOnDetection;
        this.terminationAction = Objects.requireNonNull(terminationAction);
    }

    /**
     * Runs a one-shot security scan before launching Minecraft.
     */
    public SecurityReport runInitialScan() {
        return runScanAndHandle();
    }

    /**
     * Starts periodic scans every 10 seconds.
     */
    public void startBackgroundMonitoring() {
        scheduler.scheduleAtFixedRate(this::runScanAndHandle, 10, 10, TimeUnit.SECONDS);
    }

    public void stop() {
        scheduler.shutdownNow();
    }

    private SecurityReport runScanAndHandle() {
        List<SuspiciousProcess> suspiciousProcesses = processScanner.scan();
        List<LoadedModule> suspiciousModules = windowsModuleScanner.findSuspiciousModules();
        List<String> jvmFlagsDetected = jvmArgumentScanner.scan();

        SecurityReport report = new SecurityReport(
                Instant.now(),
                suspiciousProcesses,
                suspiciousModules,
                jvmFlagsDetected
        );

        if (!report.isClean()) {
            logReport(report);
            sendWebhook(report);
            if (terminateOnDetection) {
                terminationAction.run();
            }
        }

        return report;
    }

    private void logReport(SecurityReport report) {
        report.suspiciousProcesses().forEach(process ->
                logger.warning("[SECURITY] Suspicious process detected: " + process.name() + " (PID " + process.pid() + ") reason=" + process.reason()));
        report.suspiciousModules().forEach(module ->
                logger.warning("[SECURITY] Suspicious module detected: " + module.name() + " path=" + module.path() + " baseAddress=0x" + Long.toHexString(module.baseAddress())));
        report.jvmFlagsDetected().forEach(flag ->
                logger.warning("[SECURITY] Suspicious JVM argument detected: " + flag));
    }

    private void sendWebhook(SecurityReport report) {
        String json = "{" +
                "\"username\":\"Launcher Security\"," +
                "\"content\":\"" + escapeJson(formatForWebhook(report)) + "\"" +
                "}";

        HttpRequest request = HttpRequest.newBuilder(webhookUri)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(json, StandardCharsets.UTF_8))
                .build();

        httpClient.sendAsync(request, HttpResponse.BodyHandlers.discarding())
                .exceptionally(error -> {
                    logger.log(Level.WARNING, "[SECURITY] Failed to send webhook report", error);
                    return null;
                });
    }

    private String formatForWebhook(SecurityReport report) {
        return "Security alert @" + report.timestamp() +
                " | processes=" + report.suspiciousProcesses().size() +
                " | modules=" + report.suspiciousModules().size() +
                " | jvmFlags=" + report.jvmFlagsDetected().size();
    }

    private String escapeJson(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    /**
     * Builds a default logger writing to security.log with structured format.
     */
    public static Logger buildSecurityLogger(Path logFile) throws IOException {
        Files.createDirectories(logFile.getParent());
        Logger logger = Logger.getLogger("launcher-security");
        logger.setUseParentHandlers(false);

        FileHandler fileHandler = new FileHandler(logFile.toString(), true);
        fileHandler.setFormatter(new Formatter() {
            @Override
            public String format(LogRecord record) {
                return "[" + Instant.ofEpochMilli(record.getMillis()) + "] [" + record.getLevel() + "] " + record.getMessage() + System.lineSeparator();
            }
        });

        logger.addHandler(fileHandler);
        return logger;
    }

    /**
     * Factory helper for default 10-second monitor configuration.
     */
    public static SecurityMonitor defaultMonitor(Path logFile, URI webhookUri, boolean terminateOnDetection) throws IOException {
        ProcessScanner processScanner = new ProcessScanner(List.of(
                "cheatengine", "processhacker", "x64dbg", "ollydbg", "ida", "ghidra", "wireshark", "fiddler"
        ));
        WindowsModuleScanner moduleScanner = new WindowsModuleScanner(List.of(
                "minhook", "detours", "easyhook", "cheatengine", "inject", "hack"
        ));
        JvmArgumentScanner jvmScanner = new JvmArgumentScanner();

        return new SecurityMonitor(
                processScanner,
                moduleScanner,
                jvmScanner,
                buildSecurityLogger(logFile),
                webhookUri,
                HttpClient.newHttpClient(),
                Executors.newSingleThreadScheduledExecutor(),
                terminateOnDetection,
                () -> Runtime.getRuntime().halt(1)
        );
    }
}
