package cn.photocoach.app.probe;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.util.AttributeSet;
import android.view.View;

/**
 * 验证用的叠加层：三分构图网格 + 一个人形轮廓 + 一行状态文字。
 *
 * 刻意画得很朴素 —— 这个类的目的是证明「指导层能盖在任意画面上」，
 * 不是复刻网页端那套五步标定的剪影。真正的剪影渲染仍然只在网页里做。
 *
 * 同时给 Camera2 预览和系统级悬浮窗复用，两边画出来的是同一张图。
 */
public class GuideOverlayView extends View {

    private final Paint gridPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint figurePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint textPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint badgePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path figurePath = new Path();
    private final RectF tmpRect = new RectF();

    private String status = "";
    private boolean showFigure = true;

    public GuideOverlayView(Context context) {
        this(context, null);
    }

    public GuideOverlayView(Context context, AttributeSet attrs) {
        super(context, attrs);
        float density = context.getResources().getDisplayMetrics().density;

        gridPaint.setStyle(Paint.Style.STROKE);
        gridPaint.setStrokeWidth(1f * density);
        gridPaint.setColor(Color.argb(120, 0xFF, 0xFF, 0xFF));

        figurePaint.setStyle(Paint.Style.STROKE);
        figurePaint.setStrokeWidth(2.5f * density);
        figurePaint.setColor(Color.argb(230, 0x6C, 0xE7, 0xFF));
        figurePaint.setStrokeCap(Paint.Cap.ROUND);
        figurePaint.setStrokeJoin(Paint.Join.ROUND);

        textPaint.setColor(Color.WHITE);
        textPaint.setTextSize(13f * density);

        badgePaint.setColor(Color.argb(150, 0x00, 0x00, 0x00));
        badgePaint.setStyle(Paint.Style.FILL);
    }

    /** 状态行，画在顶部的小黑条里。 */
    public void setStatus(String text) {
        this.status = text == null ? "" : text;
        invalidate();
    }

    public void setShowFigure(boolean show) {
        this.showFigure = show;
        invalidate();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        int w = getWidth();
        int h = getHeight();
        if (w == 0 || h == 0) return;

        // 三分线
        for (int i = 1; i <= 2; i++) {
            float x = w * i / 3f;
            float y = h * i / 3f;
            canvas.drawLine(x, 0, x, h, gridPaint);
            canvas.drawLine(0, y, w, y, gridPaint);
        }

        if (showFigure) {
            drawFigure(canvas, w, h);
        }

        if (!status.isEmpty()) {
            float pad = 12f * getResources().getDisplayMetrics().density;
            float textHeight = textPaint.getTextSize();
            float left = pad;
            float top = pad;
            float right = left + textPaint.measureText(status) + pad * 2;
            float bottom = top + textHeight + pad;
            tmpRect.set(left, top, right, bottom);
            canvas.drawRoundRect(tmpRect, pad, pad, badgePaint);
            canvas.drawText(status, left + pad, bottom - pad * 0.8f, textPaint);
        }
    }

    /**
     * 一个「人形」轮廓：头 + 肩 + 躯干 + 两条腿。
     * 只用来证明叠加层位置可控、能跟随取景框，不追求标定精度。
     */
    private void drawFigure(Canvas canvas, int w, int h) {
        float cx = w / 2f;
        float bodyHeight = h * 0.62f;
        float top = (h - bodyHeight) / 2f;
        float headR = bodyHeight * 0.075f;
        float headCy = top + headR;

        figurePath.reset();
        canvas.drawCircle(cx, headCy, headR, figurePaint);

        float neckY = headCy + headR;
        float shoulderY = neckY + bodyHeight * 0.09f;
        float shoulderHalf = bodyHeight * 0.13f;
        float hipY = top + bodyHeight * 0.58f;
        float hipHalf = bodyHeight * 0.09f;
        float footY = top + bodyHeight;

        // 躯干
        figurePath.moveTo(cx - shoulderHalf, shoulderY);
        figurePath.lineTo(cx + shoulderHalf, shoulderY);
        figurePath.lineTo(cx + hipHalf, hipY);
        figurePath.lineTo(cx - hipHalf, hipY);
        figurePath.close();
        canvas.drawPath(figurePath, figurePaint);

        // 手臂
        canvas.drawLine(cx - shoulderHalf, shoulderY,
                cx - shoulderHalf - bodyHeight * 0.05f, hipY, figurePaint);
        canvas.drawLine(cx + shoulderHalf, shoulderY,
                cx + shoulderHalf + bodyHeight * 0.05f, hipY, figurePaint);

        // 腿
        canvas.drawLine(cx - hipHalf, hipY, cx - hipHalf - bodyHeight * 0.03f, footY, figurePaint);
        canvas.drawLine(cx + hipHalf, hipY, cx + hipHalf + bodyHeight * 0.03f, footY, figurePaint);
    }
}
