# Hang Up Meter 화면 실행 안내

대표가 고른 화면은 디자인_개선_2.png다. 해당 배치를 기준으로 index.html, app.css, app.js와 로컬 서버를 작성했다. 현재는 크롬 파일 모드와 4173 서버 화면을 확인했고, 일반 사용자 터미널의 전체 테스트 58개와 실제 Decide 한 건이 성공했다. 새 실제 분석 화면 검증은 이어서 진행 중이다.

최신 상태: 브라우저 전용 연결 대신 기존 크롬 앱 접근으로 파일 모드 화면·클릭을 직접 확인했다. 아래 브라우저 전체 불가라는 기록은 이전 단계다. 파일 모드 아이콘과 320px 배치·하단 버튼을 수정했고, 재생·초기화·예제·입력·동의 차단·키보드 탭과 안내 창을 확인했다. 원본과 실행 중인 1487×1058 iframe은 design-comparison.html에서 나란히 볼 수 있다. 서버와 실제 API 검증은 권한 제한으로 여전히 남아 있다.

현재 세션 밖에서 검증을 재개하는 파일은 검증실행.command다. 현재 버전은 일반 터미널에서 전체 시험을 실행한 뒤 3개 합성 HTTP/API 사례와 추가 근거 단계를 확인한다. 모두 통과하면 4174 포트에 실제 분석 가능한 로컬 화면을 연다. 기존 4173 샘플 서버는 건드리지 않는다. 최대 6개 논리 API 단계와 50 관찰 크레딧 예산을 사용하며 정확한 공급자 청구 상한 보장은 아니다. 키 값은 출력하지 않고 공개 배포도 하지 않는다. 결과는 검증실행_결과.log와 eval-results-live-check-*.json/jsonl에 남는다. 에이전트는 차단된 실행을 UI 터미널 등으로 우회해 실행하지 않았다.

## 파일로 보기

현재 폴더의 index.html을 브라우저에서 직접 연다. CSS·폰트·아이콘·이미지는 모두 같은 폴더의 상대 경로를 사용한다. 브라우저의 파일 접근 정책에 따라 실행 여부를 확인해야 한다.

파일 모드는 합성 샘플 재생, 일시정지·다시 시작, 예제 전환, 입력 화면과 마이크 안내를 보는 용도다. 샘플의 경고와 강조는 직접 작성한 상태이며 Clocked 결과가 아니다. 파일 모드에서는 분석 API를 자동 호출하지 않는다. 마이크 버튼은 안내와 동의를 거친 사용자 시작 동작이 필요하며, 인식 텍스트는 화자를 구별하지 못하므로 분석 전에 직접 입력 화면에서 검토한다.

## 로컬 서버로 보기

Node.js 24 이상에서 현재 폴더를 열고 다음을 실행한다. 이번 작성 환경의 버전은 26.0.0이다. 외부 패키지 설치는 필요 없다.

```sh
npm start
```

기본 주소는 http://127.0.0.1:4173 이다. 기본 실행에서는 실제 분석이 꺼져 있고 .env.local의 키도 읽지 않는다. 실제 공개 배포는 하지 않았다.

오프라인 연결부 검증은 `npm run test:offline`, 실제 로컬 HTTP 경로 검증은 `npm run test:http`다. `npm test`는 둘을 함께 실행한다. 현재 환경에서 HTTP 검증은 소켓 생성 EPERM으로 실패했으며 통과로 표시하지 않았다.

최신 합계는 `npm run test:offline` 45개와 `npm run test:handlers` 9개로 총 54개 통과다. 아래 39개 기록은 이전 단계다.

포트를 사용하지 않는 서버 처리 검증은 `npm run test:handlers`다. 실제 서버와 같은 요청 처리 함수를 메모리에서 실행하며 8개가 통과했다. 연결부 31개와 합쳐 오프라인 39개 통과다. 실제 HTTP 연결·화면 렌더링·API 성능을 검증한 결과는 아니다.

## 실제 분석 연결

대표가 키 입력과 무료 잔량·쿠폰 상태를 확인하고 연습 평가를 수행한 다음 켠다. 서버의 HANGUP_ENABLE_LIVE와 HANGUP_FREE_CREDITS_CONFIRMED를 둘 다 1로 명시해야 한다. API 키는 서버의 .env.local에서만 읽는다. 이 플래그를 지금 실행하거나 .env.local을 수정하지 않았다.

현재 웹 경로는 Decide 결과를 화면 상태로 연결하고, 직접 입력 화면의 추가 근거 검사 선택 시 Extract·Rerank·Verify를 순차 실행하도록 작성했다. 원문 강조·선택 문서·주장 대조 결과의 화면 코드도 연결했다. 실제 API 호환·브라우저 동작·성능은 검증 전이다. 문서 두 개의 짧은 발췌만 사용하고 expand에 필요한 주변 문단은 확보하지 않아 추가 자료 필요로 표시한다. 실제 분석이 실패하면 샘플 답으로 대체하지 않는다. 서버에서는 정해진 정적 자산만 제공하며 키·문서·코드·평가 보고서를 그대로 내려주지 않도록 구성했다. 실제 HTTP 검증 후 재확인이 필요하다.

## 사용한 자산

- 폰트: Google Fonts의 Manrope, font-manrope.ttf와 font-manrope-license.txt.
- 아이콘: Heroicons의 24px outline, icon-*.svg와 icons-license.txt.
- 로고: 선택한 시안을 참조해 기본 제공 image_gen으로 생성·수정한 brandmark.png. 다른 참가자 코드나 자산은 사용하지 않았다.

선택 이미지와 실제 화면의 비교가 완료되기 전에는 디자인 검수 완료나 앱 완성으로 소개하지 않는다. 검수 상태는 design-qa.md에 있다.

## 로고 생성 기록

기본 제공 image_gen에 디자인_개선_2.png를 실제 참조로 첨부했다. 첫 프롬프트는 다음과 같다.

Create a single transparent-background logo asset for the attached Hang Up Meter app screenshot. Extract/recreate ONLY the small phone symbol at the top left of the reference: a solid midnight-navy telephone handset tilted diagonally with three small warm amber/orange signal rays at its upper right. Match its simple friendly proportions and silhouette. Asset only, no text or wordmark, no circle badge, no frame, no gradient, no shadow. Center the symbol with small even transparent padding, target 256 x 256 square, crisp edges suitable for rendering at 48 CSS pixels. Preserve the logo appearance from the supplied screenshot. Transparent background required.

생성된 첫 자산의 번짐을 줄이려고 첫 이미지를 실제 편집 대상으로 첨부하고 다음 프롬프트를 적용했다. 최종 자산은 brandmark.png다. 파이썬이나 SVG로 로고를 그리지 않았다.

Edit this logo asset. Preserve exactly the handset and the three rounded rays, but remove ALL glow, red halos, particles, texture, gradients, shadows, and mottled edge pixels. Use exactly two completely flat opaque ink colors: handset #0D1734 and rays #F59A13. All other pixels must be fully transparent, including between the shapes. The outlines should be crisp, smooth, clean and solid. No text, no border, no new shapes. Center on a square with minimal even transparent padding. This is a tiny UI logo, not a rendered 3D illustration. Transparent background.
