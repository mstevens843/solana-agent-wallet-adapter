package com.agentic.wallet

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.util.Size
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import com.agentic.wallet.mwa.AgentMwaLog
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class QrScannerActivity : ComponentActivity() {
    private lateinit var previewView: PreviewView
    private lateinit var focusRing: View
    private val analyzerExecutor = Executors.newSingleThreadExecutor()
    private val scanner: BarcodeScanner by lazy {
        BarcodeScanning.getClient(
            BarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .build(),
        )
    }
    private var cameraProvider: ProcessCameraProvider? = null
    private var camera: Camera? = null
    @Volatile private var completed = false
    @Volatile private var analyzing = false
    @Volatile private var firstFrameLogged = false
    private var frameCounter = 0L // analyzer-thread-confined; no @Volatile needed
    private val cameraPermissionLauncher: ActivityResultLauncher<String> =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            AgentMwaLog.info(
                "QrScannerActivity",
                "cameraPermission",
                if (granted) "GRANTED" else "DENIED",
                "QR scanner camera permission result received",
                mapOf("granted" to granted),
            )
            if (granted) startCamera() else finishError("permission_denied")
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        buildUi()
        val permissionGranted = ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
        AgentMwaLog.info(
            "QrScannerActivity",
            "onCreate",
            "START",
            "QR scanner activity created",
            mapOf("cameraPermissionGranted" to permissionGranted),
        )
        if (permissionGranted) {
            startCamera()
        } else {
            AgentMwaLog.info(
                "QrScannerActivity",
                "cameraPermission",
                "REQUEST",
                "requesting QR scanner camera permission",
            )
            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    private fun buildUi() {
        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        }
        previewView = PreviewView(this).apply {
            scaleType = PreviewView.ScaleType.FILL_CENTER
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            )
            setOnTouchListener { _, event ->
                if (event.action == MotionEvent.ACTION_UP) {
                    focusAt(event.x, event.y)
                    true
                } else {
                    true
                }
            }
        }
        focusRing = View(this).apply {
            visibility = View.GONE
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(18).toFloat()
                setColor(Color.TRANSPARENT)
                setStroke(3, Color.rgb(95, 227, 161))
            }
            val ringSize = dp(82)
            layoutParams = FrameLayout.LayoutParams(ringSize, ringSize)
        }
        root.addView(previewView)
        root.addView(scanFrame())
        root.addView(focusRing)
        root.addView(topBar())
        root.addView(bottomHint())
        setContentView(root)
    }

    private fun topBar(): View {
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(24), dp(20), dp(24), dp(12))
            background = GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM,
                intArrayOf(Color.argb(190, 0, 0, 0), Color.TRANSPARENT),
            )
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP,
            )
            addView(TextView(context).apply {
                text = "Scan computer QR"
                setTextColor(Color.WHITE)
                textSize = 20f
                typeface = android.graphics.Typeface.DEFAULT_BOLD
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            })
            addView(Button(context).apply {
                text = "Cancel"
                setTextColor(Color.WHITE)
                setOnClickListener { finishCancelled() }
            })
        }
    }

    private fun bottomHint(): View {
        return TextView(this).apply {
            text = "Point at the QR on your AI-connected computer. Tap the QR to focus."
            setTextColor(Color.WHITE)
            textSize = 16f
            gravity = Gravity.CENTER
            setPadding(dp(28), dp(18), dp(28), dp(28))
            background = GradientDrawable(
                GradientDrawable.Orientation.BOTTOM_TOP,
                intArrayOf(Color.argb(205, 0, 0, 0), Color.TRANSPARENT),
            )
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM,
            )
        }
    }

    private fun scanFrame(): View {
        val size = minOf(resources.displayMetrics.widthPixels - dp(48), dp(300))
        return View(this).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(28).toFloat()
                setColor(Color.TRANSPARENT)
                setStroke(5, Color.rgb(95, 227, 161))
            }
            layoutParams = FrameLayout.LayoutParams(size, size, Gravity.CENTER)
        }
    }

    private fun startCamera() {
        AgentMwaLog.info(
            "QrScannerActivity",
            "startCamera",
            "START",
            "starting QR scanner camera",
        )
        val providerFuture = ProcessCameraProvider.getInstance(this)
        providerFuture.addListener({
            try {
                val provider = providerFuture.get()
                cameraProvider = provider
                if (!provider.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA)) {
                    AgentMwaLog.warn(
                        "QrScannerActivity",
                        "startCamera",
                        "NO_BACK_CAMERA",
                        "QR scanner could not find a back camera",
                    )
                    finishError("camera_unavailable")
                    return@addListener
                }
                val preview = Preview.Builder().build().also {
                    it.surfaceProvider = previewView.surfaceProvider
                }
                // Feed ML Kit a 720p analysis stream. Without a ResolutionSelector, CameraX
                // defaults ImageAnalysis to ~640x480 — too few pixels-per-module to decode a
                // dense, monitor-displayed QR even when the preview is sharp.
                val resolutionSelector = ResolutionSelector.Builder()
                    .setAspectRatioStrategy(AspectRatioStrategy.RATIO_16_9_FALLBACK_AUTO_STRATEGY)
                    .setResolutionStrategy(
                        ResolutionStrategy(
                            Size(1280, 720),
                            ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER,
                        ),
                    )
                    .build()
                val analysis = ImageAnalysis.Builder()
                    .setResolutionSelector(resolutionSelector)
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                    .also {
                        it.setAnalyzer(analyzerExecutor) { imageProxy -> analyzeImage(imageProxy) }
                    }
                provider.unbindAll()
                camera = provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                AgentMwaLog.info(
                    "QrScannerActivity",
                    "startCamera",
                    "BOUND",
                    "QR scanner camera bound",
                    mapOf("previewWidth" to previewView.width, "previewHeight" to previewView.height),
                )
                previewView.postDelayed({
                    focusAt(previewView.width / 2f, previewView.height / 2f)
                }, 450)
            } catch (err: Throwable) {
                AgentMwaLog.failure(
                    "QrScannerActivity",
                    "startCamera",
                    "BIND_FAILED",
                    "QR scanner camera bind failed",
                    err,
                )
                finishError("camera_unavailable")
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun analyzeImage(imageProxy: ImageProxy) {
        if (completed || analyzing) {
            imageProxy.close()
            return
        }
        val image = imageProxy.image
        if (image == null) {
            imageProxy.close()
            return
        }

        frameCounter++
        // Read frame metadata from the ImageProxy before process() consumes the underlying image.
        val frameWidth = imageProxy.width
        val frameHeight = imageProxy.height
        val rotation = imageProxy.imageInfo.rotationDegrees
        val format = imageProxy.format

        if (!firstFrameLogged) {
            firstFrameLogged = true
            AgentMwaLog.info(
                "QrScannerActivity",
                "analyzeImage",
                "FIRST_FRAME",
                "QR scanner received first analysis frame",
                mapOf(
                    "width" to frameWidth,
                    "height" to frameHeight,
                    "rotationDegrees" to rotation,
                    "imageFormat" to format,
                ),
            )
        }

        analyzing = true
        try {
            val input = InputImage.fromMediaImage(image, rotation)
            scanner.process(input)
                .addOnSuccessListener { barcodes ->
                    if (completed) return@addOnSuccessListener
                    if (frameCounter % 30L == 0L) {
                        AgentMwaLog.debug(
                            "QrScannerActivity",
                            "analyzeImage",
                            "HEARTBEAT",
                            "QR scanner analysis heartbeat",
                            mapOf(
                                "frame" to frameCounter,
                                "barcodeCount" to barcodes.size,
                                "width" to frameWidth,
                                "height" to frameHeight,
                            ),
                        )
                    }
                    val rawValue = barcodes.firstOrNull { !it.rawValue.isNullOrBlank() }?.rawValue
                    if (!rawValue.isNullOrBlank()) {
                        completed = true
                        AgentMwaLog.info(
                            "QrScannerActivity",
                            "analyzeImage",
                            "QR_DETECTED",
                            "QR scanner decoded a QR payload",
                            mapOf("rawChars" to rawValue.length),
                        )
                        finishOk(rawValue)
                    }
                }
                .addOnFailureListener { err ->
                    AgentMwaLog.failure(
                        "QrScannerActivity",
                        "analyzeImage",
                        "PROCESS_FAILED",
                        "QR scanner ML Kit process() failed",
                        err,
                    )
                }
                .addOnCompleteListener {
                    analyzing = false
                    imageProxy.close()
                }
        } catch (err: Throwable) {
            AgentMwaLog.failure(
                "QrScannerActivity",
                "analyzeImage",
                "PROCESS_THREW",
                "QR scanner process() threw synchronously",
                err,
            )
            analyzing = false
            imageProxy.close()
        }
    }

    private fun focusAt(x: Float, y: Float) {
        val currentCamera = camera ?: return
        AgentMwaLog.debug(
            "QrScannerActivity",
            "focusAt",
            "START",
            "QR scanner focus requested",
            mapOf("x" to x, "y" to y),
        )
        val point = previewView.meteringPointFactory.createPoint(x, y)
        val action = FocusMeteringAction.Builder(
            point,
            FocusMeteringAction.FLAG_AF or FocusMeteringAction.FLAG_AE or FocusMeteringAction.FLAG_AWB,
        )
            .setAutoCancelDuration(3, TimeUnit.SECONDS)
            .build()
        currentCamera.cameraControl.startFocusAndMetering(action)
        showFocusRing(x, y)
    }

    private fun showFocusRing(x: Float, y: Float) {
        val params = focusRing.layoutParams as FrameLayout.LayoutParams
        params.leftMargin = (x - params.width / 2f).toInt()
        params.topMargin = (y - params.height / 2f).toInt()
        focusRing.layoutParams = params
        focusRing.visibility = View.VISIBLE
        focusRing.animate().cancel()
        focusRing.alpha = 1f
        focusRing.animate()
            .alpha(0f)
            .setStartDelay(650)
            .setDuration(250)
            .withEndAction { focusRing.visibility = View.GONE }
            .start()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun finishOk(rawValue: String) {
        AgentMwaLog.info(
            "QrScannerActivity",
            "finishOk",
            "DONE",
            "QR scanner returning payload",
            mapOf("rawChars" to rawValue.length),
        )
        setResult(RESULT_OK, Intent().putExtra(EXTRA_RAW_VALUE, rawValue))
        finish()
    }

    private fun finishCancelled() {
        AgentMwaLog.info(
            "QrScannerActivity",
            "finishCancelled",
            "DONE",
            "QR scanner cancelled",
        )
        setResult(RESULT_CANCELED, Intent().putExtra(EXTRA_ERROR, "cancelled"))
        finish()
    }

    private fun finishError(error: String) {
        AgentMwaLog.warn(
            "QrScannerActivity",
            "finishError",
            "DONE",
            "QR scanner returning error",
            mapOf("error" to error),
        )
        setResult(RESULT_CANCELED, Intent().putExtra(EXTRA_ERROR, error))
        finish()
    }

    override fun onDestroy() {
        cameraProvider?.unbindAll()
        scanner.close()
        analyzerExecutor.shutdownNow()
        super.onDestroy()
    }

    companion object {
        const val EXTRA_RAW_VALUE = "com.agentic.wallet.QR_RAW_VALUE"
        const val EXTRA_ERROR = "com.agentic.wallet.QR_ERROR"
    }
}
