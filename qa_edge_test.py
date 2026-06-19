from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={'width':1280,'height':800})
    page = ctx.new_page()
    errors = []
    page.on('console', lambda msg: errors.append(msg.text) if msg.type=='error' else None)
    page.goto('http://localhost:3000', wait_until='networkidle', timeout=20000)
    page.wait_for_selector('#coldOverlay', state='detached', timeout=10000)

    # 엣지1: 노선 미선택시 역 입력창 비활성
    disabled = page.get_attribute('#stationInput', 'disabled')
    print('[엣지1] noLine stationInput disabled=' + repr(disabled) + ' (기대: empty string)')

    # 엣지2: 2호선에 서울역 검색 (서울역은 1호선)
    page.select_option('#lineSelect', '2호선')
    page.wait_for_timeout(500)
    page.fill('#stationInput', '서울역')
    page.wait_for_timeout(400)
    drop_count = page.locator('#stationDropdown li').count()
    drop_hidden = page.get_attribute('#stationDropdown', 'hidden')
    print('[엣지2] 2호선+서울역 검색 drop_count=' + str(drop_count) + ', hidden=' + repr(drop_hidden))

    # 엣지3: 비교뷰 5개 추가 시도 (최대 4개)
    page.click('.view-tab[data-target="compare"]')
    page.wait_for_timeout(500)
    for st in ['강남', '홍대입구', '신촌', '이대', '합정']:
        page.fill('#compareInput', st)
        page.wait_for_timeout(300)
        if page.locator('#compareDropdown li').count() > 0:
            page.locator('#compareDropdown li').first.click()
            page.wait_for_timeout(200)
            page.click('#compareAddBtn')
            page.wait_for_timeout(200)
    chips = page.locator('.compare-chip').count()
    print('[엣지3] 5개시도 실제chips=' + str(chips) + ' (기대: 4)')

    # 엣지4: 방향 토글
    page.click('.view-tab[data-target="predict"]')
    page.wait_for_timeout(300)
    page.select_option('#lineSelect', '2호선')
    page.wait_for_timeout(700)
    page.fill('#stationInput', '강남')
    page.wait_for_timeout(300)
    page.locator('#stationDropdown li').first.click()
    page.wait_for_timeout(1800)
    dir_btns = page.locator('#directionBtns .dir-btn').all()
    btn_names = [b.text_content() for b in dir_btns]
    print('[엣지4] 방향 버튼: ' + str(btn_names))
    if len(dir_btns) >= 2:
        dir_btns[1].click()
        page.wait_for_timeout(800)
        active = page.locator('#directionBtns .dir-btn.active').text_content()
        print('[엣지4] 토글 후 active=' + active)

    # oklch 색상 확인
    c_low      = page.evaluate('getComputedStyle(document.documentElement).getPropertyValue("--c-low").trim()')
    c_medium   = page.evaluate('getComputedStyle(document.documentElement).getPropertyValue("--c-medium").trim()')
    c_high     = page.evaluate('getComputedStyle(document.documentElement).getPropertyValue("--c-high").trim()')
    c_critical = page.evaluate('getComputedStyle(document.documentElement).getPropertyValue("--c-critical").trim()')
    print('[oklch] low=' + c_low)
    print('[oklch] medium=' + c_medium)
    print('[oklch] high=' + c_high)
    print('[oklch] critical=' + c_critical)

    print('[JS에러] ' + str(len(errors)) + '건')
    browser.close()

print('=== 엣지케이스 검증 완료 ===')
