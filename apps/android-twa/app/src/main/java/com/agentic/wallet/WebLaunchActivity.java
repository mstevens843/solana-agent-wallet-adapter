package com.agentic.wallet;

import android.content.Intent;
import android.net.Uri;

import com.google.androidbrowserhelper.trusted.LauncherActivity;

public final class WebLaunchActivity extends LauncherActivity {
    @Override
    protected Uri getLaunchingUrl() {
        Intent intent = getIntent();
        Uri data = intent == null ? null : intent.getData();
        if (isAllowedLaunchUri(data)) {
            return data;
        }
        return Uri.parse(BuildConfig.AGENTIC_LAUNCH_URL);
    }

    private static boolean isAllowedLaunchUri(Uri uri) {
        if (uri == null) {
            return false;
        }

        String scheme = uri.getScheme();
        if (scheme == null || !BuildConfig.AGENTIC_LAUNCH_SCHEME.equalsIgnoreCase(scheme)) {
            return false;
        }

        String host = uri.getHost();
        if (host == null || !BuildConfig.AGENTIC_LAUNCH_HOST.equalsIgnoreCase(host)) {
            return false;
        }

        return uri.getPort() == BuildConfig.AGENTIC_LAUNCH_PORT;
    }
}
