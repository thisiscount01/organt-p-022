"""
콜드 스타트 오버레이 Playwright 검증 스크립트
- 오버레이 등장 확인
- 프로그레스 바 진행 확인
- lines API 완료 후 오버레이 자동 소멸 확인
- JS 런타임 에러 0건 확인
"""
import asyncio
from playwright.async_api import async_playwright


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])
        page = await browser.new_page()

        js_errors = []
        console_errors = []

        page.on("pageerror", lambda e: js_errors.append(str(e)))
        page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)

        # 페이지 로드
        await page.goto("http://localhost:3000", wait_until="domcontentloaded")

        # 1) 오버레이가 즉시 존재하는지
        overlay_exists = await page.evaluate("!!document.getElementById('coldOverlay')")
        print(f"[1] 오버레이 로드 직후 존재: {overlay_exists}")

        # 2) 2초 후 프로그레스 바 진행 확인
        await asyncio.sleep(2)
        bar_width = await page.evaluate(
            "document.getElementById('coldProgressBar') "
            "? document.getElementById('coldProgressBar').style.width "
            ": 'REMOVED'"
        )
        pct_text = await page.evaluate(
            "document.getElementById('coldPctText') "
            "? document.getElementById('coldPctText').textContent "
            ": 'REMOVED'"
        )
        print(f"[2] 2초 후 프로그레스 bar.width={bar_width}, 표시퍼센트={pct_text}")

        # 3) lines API 완료(lineSelect 옵션 채워짐) 대기
        try:
            await page.wait_for_function(
                "document.getElementById('lineSelect') "
                "&& document.getElementById('lineSelect').options.length > 1",
                timeout=20000
            )
            print("[3] lineSelect 옵션 채워짐 ✓ (lines API 완료)")
        except Exception as e:
            print(f"[3] lineSelect 대기 타임아웃: {e}")

        # 4) __hideColdOverlay 호출 후 0.8s → opacity 전환 중인지
        await asyncio.sleep(0.8)
        overlay_opacity = await page.evaluate(
            "document.getElementById('coldOverlay') "
            "? document.getElementById('coldOverlay').style.opacity "
            ": 'REMOVED'"
        )
        print(f"[4] 호출 0.8s 후 오버레이 opacity: {overlay_opacity!r}")

        # 5) fade-out 완료 후 DOM 제거 확인 (transition 0.5s + 여유 0.8s)
        await asyncio.sleep(1.0)
        overlay_gone = await page.evaluate("document.getElementById('coldOverlay') === null")
        print(f"[5] fade-out 완료 후 오버레이 DOM 제거됨: {overlay_gone}")

        # 6) JS 에러 수
        print(f"[6] JS 런타임 에러: {len(js_errors)}건")
        for err in js_errors:
            print(f"    ⚠ {err}")
        print(f"[6] 콘솔 에러: {len(console_errors)}건")
        for err in console_errors:
            print(f"    ⚠ {err}")

        # 7) window.__hideColdOverlay 타입
        fn_type = await page.evaluate("typeof window.__hideColdOverlay")
        print(f"[7] window.__hideColdOverlay type: {fn_type}")

        # 8) lineSelect 최종 옵션 수
        opt_count = await page.evaluate("document.getElementById('lineSelect').options.length")
        print(f"[8] lineSelect 옵션 수: {opt_count}개 (1개는 placeholder)")

        # 종합 판정
        # bar_width='REMOVED' 허용: 로컬 warm 서버에서 lines API가 2초 내 응답해
        # 오버레이가 이미 제거된 경우 — 정상 동작(콜드 스타트 시엔 20~30s 유지됨)
        bar_ok = bar_width not in ("", "0%") or bar_width == "REMOVED"
        ok = (
            overlay_exists  # 로드 직후 존재
            and bar_ok      # 바가 전진했거나 빠르게 소멸
            and overlay_gone  # 최종 DOM 제거
            and len(js_errors) == 0  # JS 에러 없음
            and fn_type == "function"  # 함수 등록
            and opt_count > 1  # 노선 로드 성공
        )
        print()
        print("══ 종합 판정:", "✅ 전체 PASS" if ok else "❌ 일부 FAIL")
        if not ok:
            details = {
                "overlay_exists": overlay_exists,
                "bar_ok": bar_ok,
                "overlay_gone": overlay_gone,
                "js_errors_0": len(js_errors) == 0,
                "fn_registered": fn_type == "function",
                "lines_loaded": opt_count > 1,
            }
            print("   실패 항목:", {k: v for k, v in details.items() if not v})

        await browser.close()


asyncio.run(main())
