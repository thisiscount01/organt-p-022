from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    errors = []
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append(str(e)))

    page.goto('http://localhost:3000/', wait_until='domcontentloaded', timeout=10000)
    page.wait_for_timeout(2000)

    title = page.text_content('.brand-title') or 'MISSING'
    line_opts = page.evaluate('document.getElementById("lineSelect").options.length')
    stat = page.text_content('#statStations') or '-'
    print(f'타이틀: {title} | 노선옵션: {line_opts} | 통계: {stat}')

    # 2호선 선택 → 강남
    page.select_option('#lineSelect', '2호선')
    page.wait_for_timeout(700)
    page.fill('#stationInput', '강남')
    page.wait_for_timeout(400)
    drop_item = page.evaluate('document.querySelector("#stationDropdown li")?.textContent || "NONE"')
    print(f'자동완성 첫항목: {drop_item}')
    page.click('#stationDropdown li')
    page.wait_for_timeout(2500)

    result_ok = page.evaluate('!document.getElementById("resultPanel").hidden')
    top3 = page.evaluate('document.querySelectorAll(".top3-item").length')
    cmts = page.evaluate('document.querySelectorAll("#insightComments li").length')
    print(f'결과패널: {result_ok} | TOP3: {top3} | AI코멘트: {cmts}')

    # 히트맵 뷰
    page.click('[data-target="heatmap"]')
    page.wait_for_timeout(300)
    page.select_option('#heatmapLineSelect', '2호선')
    page.wait_for_timeout(2500)
    hm_ok = page.evaluate('!document.getElementById("heatmapPanel").hidden')
    hm_rows = page.evaluate('document.querySelectorAll("#heatmapTable tbody tr").length')
    print(f'히트맵: {hm_ok} | 역행수: {hm_rows}')

    # 비교 뷰
    page.click('[data-target="compare"]')
    page.wait_for_timeout(300)
    page.fill('#compareInput', '강남')
    page.wait_for_timeout(300)
    li1 = page.query_selector('#compareDropdown li')
    if li1: li1.click()
    page.wait_for_timeout(200)
    page.click('#compareAddBtn')
    page.fill('#compareInput', '역삼')
    page.wait_for_timeout(300)
    li2 = page.query_selector('#compareDropdown li')
    if li2: li2.click()
    page.wait_for_timeout(200)
    page.click('#compareAddBtn')
    page.wait_for_timeout(1800)
    cmp_ok = page.evaluate('!document.getElementById("comparePanel").hidden')
    chips = page.evaluate('document.querySelectorAll(".compare-chip").length')
    print(f'비교차트: {cmp_ok} | 칩: {chips}')

    # 실시간 뷰
    page.click('[data-target="realtime"]')
    page.wait_for_timeout(300)
    page.select_option('#rtLineSelect', '2호선')
    page.wait_for_timeout(600)
    page.fill('#rtStationInput', '강남')
    page.wait_for_timeout(400)
    rt_li = page.query_selector('#rtStationDropdown li')
    if rt_li: rt_li.click()
    page.wait_for_timeout(1800)
    rt_ok = page.evaluate('!document.getElementById("rtFullPanel").hidden')
    rt_pct = page.text_content('#rtFullPct') or 'MISSING'
    print(f'실시간패널: {rt_ok} | 혼잡도표시: {rt_pct}')

    print(f'JS에러: {errors[:3] if errors else "없음"}')
    browser.close()
