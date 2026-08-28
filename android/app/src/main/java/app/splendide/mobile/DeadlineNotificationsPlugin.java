package app.splendide.mobile;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "DeadlineNotifications")
public class DeadlineNotificationsPlugin extends Plugin {
    private static final String DEADLINE_CHANNEL_ID = "deadlines";
    private static final String SHARED_CHANNEL_ID = "shared-pages";

    @PluginMethod
    public void createChannels(PluginCall call) {
        createChannel(DEADLINE_CHANNEL_ID);
        createChannel(SHARED_CHANNEL_ID);
        call.resolve(new JSObject());
    }

    @PluginMethod
    public void show(PluginCall call) {
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            call.reject("Notification permission was not granted");
            return;
        }

        String id = bounded(call.getString("id", "task-deadline"), 300);
        String requestedChannel = call.getString("channelId", DEADLINE_CHANNEL_ID);
        String channelId = SHARED_CHANNEL_ID.equals(requestedChannel) ? SHARED_CHANNEL_ID : DEADLINE_CHANNEL_ID;
        createChannel(channelId);
        String title = bounded(call.getString("title", "Splendide"), 100);
        String body = bounded(call.getString("body", "A task needs your attention"), 160);
        String pageId = bounded(call.getString("pageId", ""), 100);
        String taskId = bounded(call.getString("taskId", ""), 100);
        String shareToken = bounded(call.getString("shareToken", ""), 300);

        Uri.Builder deepLink = new Uri.Builder().scheme("splendide").authority("deadline");
        if (!pageId.isEmpty()) deepLink.appendQueryParameter("pageId", pageId);
        if (!taskId.isEmpty()) deepLink.appendQueryParameter("taskId", taskId);
        if (!shareToken.isEmpty()) deepLink.appendQueryParameter("shareToken", shareToken);

        Intent intent = new Intent(Intent.ACTION_VIEW, deepLink.build(), getContext(), MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            getContext(),
            id.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        NotificationCompat.Builder notification = new NotificationCompat.Builder(getContext(), channelId)
            .setSmallIcon(R.drawable.ic_stat_splendide)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent);

        try {
            NotificationManagerCompat.from(getContext()).notify(id.hashCode(), notification.build());
            call.resolve(new JSObject());
        } catch (SecurityException error) {
            call.reject("Notification permission was not granted", error);
        }
    }

    private void createChannel(String channelId) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        boolean deadline = DEADLINE_CHANNEL_ID.equals(channelId);
        NotificationChannel channel = new NotificationChannel(
            channelId,
            deadline ? "Deadline reminders" : "Shared pages",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription(deadline
            ? "Reminders for task deadlines you choose"
            : "Updates when an item is added to a shared page");
        channel.enableVibration(true);
        AudioAttributes audio = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
            .build();
        channel.setSound(Settings.System.DEFAULT_NOTIFICATION_URI, audio);
        NotificationManager manager = getContext().getSystemService(NotificationManager.class);
        manager.createNotificationChannel(channel);
    }

    private String bounded(String value, int maximumLength) {
        String trimmed = value == null ? "" : value.trim();
        return trimmed.substring(0, Math.min(trimmed.length(), maximumLength));
    }
}
