e나라도움 API 가이드 반영

- T_OPD_PRMSCT_SBBGST 분야부문별 국고보조금 예산 API 기본 설정 반영.
- 기본 조회 연도 2021(사용자 가이드 예제), resultType=json, pageNo=1, numOfRows=10. 필요 연도는 화면 Connector URL의 bsnsyear에서 변경. URL에 지정한 연도를 기본 query로 덮어쓰지 않음.
- BSNSYEAR / BGAMT 및 REALM_CODE·SECT_CODE 복합 저장 키로 분야·부문별 중복 덮어쓰기 방지. 예산액 지표 bojo.budget.by_sector로 분리. 통화 단위는 가이드에서 검증되지 않아 임의 KRW로 주장하지 않음.
- totalCount/numOfRows에 따른 페이지 이어달리기, 페이지 cursor 저장 및 오류/누락 필드 차단. JSON 응답 경로는 response.body.items.item 기본값, 대체 items 구조 처리. 실제 운영 응답 형태가 다르면 오류로 표시.
- 인코딩 인증키는 요청 전에 한 번 디코딩하고 URLSearchParams로 다시 인코딩. 소스/ZIP에 실제 인증키 포함하지 않음.

적용
1. 수정 파일을 저장소에 폴더 구조대로 반영하고 Worker 배포.
2. GitHub Actions Secret BOJO_API_KEY 등록(Decoding 키 권장).
3. 기존 비활성/빈 설정 갱신을 위해 플랫폼 Case B 계층 생성 버튼을 한 번 클릭. 기본 e나라도움 설정이 저장되고 공식 수집 작업 예약.
4. 필요 연도는 e나라도움 URL bsnsyear 값 변경 후 Case B 계층 생성으로 저장.
5. 공식데이터 수집 및 DCV research compute 실행 후 last_status와 rows 확인.

검증: 167개 테스트 중 164 통과, 3 skip, 실패 0. 페이지 재개·부문별 행 보존·키 인코딩·API 오류 차단 회귀 테스트. Wrangler dry-run 통과. 실제 키를 이용한 운영 수집 및 배포는 실행하지 않았으며 모의 응답 구조 검증임.

이 자료는 예산액이며 실제 집행액, 지급정지 결과, 부정수급 정답으로 간주하지 않음. 열린재정의 구체 조회 API 설정은 별도 명세가 필요하므로 임의 추가하지 않음.
