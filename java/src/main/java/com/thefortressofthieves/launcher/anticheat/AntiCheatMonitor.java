package com.thefortressofthieves.launcher.anticheat;

import java.io.IOException;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.logging.FileHandler;
import java.util.logging.Formatter;
import java.util.logging.Level;
import java.util.logging.LogRecord;
import java.util.logging.Logger;

/**
 * Coordinates process and thread scans and sends webhook alerts when suspicious activity is detected.
 */
public class AntiCheatMonitor {
    private static final String DEFAULT_WEBHOOK_URL = "https://discord.com/api/webhooks/1479979837920645391/gk-m5A21RWsqS5xR4y1DZgJJmrp-X8bKE8u6_Swc8O1ZPhRvq9uuhYvt8mbgxk910qkw";
    private static final int SCAN_INTERVAL_SECONDS = 10;

    private final ProcessScanner processScanner;
    private final ThreadScanner threadScanner;
    private final WebhookNotifier webhookNotifier;
    private final ScheduledExecutorService scheduler;
    private final Logger logger;

    /**
     * Creates a monitor with scanner, notifier, and scheduler dependencies.
     *
     * @param processScanner scanner for suspicious processes.
     * @param threadScanner scanner for suspicious classes.
     * @param webhookNotifier notifier for webhook alerts.
     * @param scheduler scheduler used for periodic scans.
     * @param logger logger writing to local anti-cheat log.
     */
    public AntiCheatMonitor(
        ProcessScanner processScanner,
        ThreadScanner threadScanner,
        WebhookNotifier webhookNotifier,
        ScheduledExecutorService scheduler,
        Logger logger
    ) {
        this.processScanner = processScanner;
        this.threadScanner = threadScanner;
        this.webhookNotifier = webhookNotifier;
        this.scheduler = scheduler;
        this.logger = logger;
    }

    /**
     * Starts periodic anti-cheat scanning with default configuration.
     *
     * @return active monitor instance.
     */
    public static AntiCheatMonitor start() {
        Logger logger = createLogger();
        AntiCheatMonitor monitor = new AntiCheatMonitor(
            new ProcessScanner(),
            new ThreadScanner(),
            new WebhookNotifier(DEFAULT_WEBHOOK_URL),
            Executors.newSingleThreadScheduledExecutor(),
            logger
        );

        monitor.scheduler.scheduleAtFixedRate(
            monitor::scan,
            0,
            SCAN_INTERVAL_SECONDS,
            TimeUnit.SECONDS
        );

        logger.info("AntiCheatMonitor started with scan interval " + SCAN_INTERVAL_SECONDS + " seconds.");
        return monitor;
    }

    /**
     * Runs one anti-cheat scan cycle.
     */
    public void scan() {
        logger.info("Anti-cheat scan started.");

        List<String> suspiciousProcesses = processScanner.scanSuspiciousProcesses();
        List<String> suspiciousClasses = threadScanner.scanSuspiciousClasses();

        if (suspiciousProcesses.isEmpty() && suspiciousClasses.isEmpty()) {
            logger.info("No suspicious activity detected.");
            return;
        }

        logger.warning("Suspicious processes detected: " + suspiciousProcesses);
        logger.warning("Suspicious classes detected: " + suspiciousClasses);

        try {
            webhookNotifier.sendAlert(suspiciousProcesses, suspiciousClasses);
            logger.info("Webhook alert sent successfully.");
        } catch (IOException ex) {
            logger.log(Level.WARNING, "Failed to send webhook alert.", ex);
        }
    }

    /**
     * Stops periodic scanning and releases scheduler resources.
     */
    public void stop() {
        scheduler.shutdownNow();
        logger.info("AntiCheatMonitor stopped.");
    }

    private static Logger createLogger() {
        Logger logger = Logger.getLogger(AntiCheatMonitor.class.getName());
        logger.setUseParentHandlers(false);

        try {
            Path logFile = Path.of("anticheat.log");
            FileHandler fileHandler = new FileHandler(logFile.toString(), true);
            fileHandler.setFormatter(new SimpleLineFormatter());
            logger.addHandler(fileHandler);
        } catch (IOException e) {
            logger.log(Level.WARNING, "Failed to initialize anticheat.log file handler.", e);
        }

        return logger;
    }

    private static class SimpleLineFormatter extends Formatter {
        @Override
        public String format(LogRecord record) {
            return "%s [%s] %s%n".formatted(record.getMillis(), record.getLevel(), record.getMessage());
        }
    }
}
