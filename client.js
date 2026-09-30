// dsh-model-stats - Client half.
//
// A panel on this bundle's page in the Plugins section, over the host's
// `GET /api/model-stats`. It renders the same
// aggregation the `model_stats` tool returns, so what the agent reads and what
// the human sees cannot drift apart.
//
// The factory is lazy and side-effect free: all fetching happens in effects on
// the mounted component, and the stylesheet travels in the rendered tree — a
// panel nobody opens costs no style of its own.

window.__ModuleLoader__.load({
  id: 'dsh-model-stats',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // The direction every sort key is offered in, and the one a heading starts
    // in when it is clicked: the direction that puts the rows worth reading on
    // top — the fastest response first, the busiest model first, the most errors
    // first. The other direction is the same order turned around, so the click on
    // the active heading is a reversal rather than a second rule.
    //
    // These are the host's own defaults (`SORT_KEYS` in `lib/fold.js`), kept here
    // because the panel has to know which arrow to draw before the first answer
    // arrives. They cannot disagree about the rows: every request names the
    // direction it wants, so a stale copy of this map would cost an arrow, not an
    // order.
    //
    // The map is also the panel's set of orders: it has one key per column of the
    // table, so a stored preference naming a key that is not in it is not an
    // order this table can show and is not restored. Every column of the table
    // has a key here, which is what makes the host's own default the direction a
    // heading starts in — the eight orders below `cache` were missing from this
    // map when the status column was given its own, and a heading that started
    // its own key in `asc` while the host opens it in `desc` is a first click
    // that shows the reader the opposite of what every other order does.
    const SORT_DIRS = {
      steps: 'desc',
      ttft: 'asc',
      speed: 'desc',
      errors: 'desc',
      lastSeen: 'desc',
      name: 'asc',
      ttftP90: 'asc',
      tpsMax: 'desc',
      confidence: 'desc',
      llm: 'asc',
      cache: 'desc',
      retry: 'desc',
      ttftClean: 'asc',
      e2e: 'desc',
      prefill: 'desc',
      overhead: 'asc',
      errorRate: 'desc',
      modelErrors: 'desc',
      interrupted: 'desc',
      // The one order that is not a measurement: the host ranks a row by how
      // loudly its status shouts (a row that cannot be run at all above one that
      // did not answer, above one out of allowance, above one that is fine) and
      // the panel opens on the broken end of that.
      liveness: 'desc',
    }

    /** The other direction, for the heading the user just clicked twice. */
    function flipDirection(dir) {
      return dir === 'asc' ? 'desc' : 'asc'
    }

    const DEFAULT_QUERY = { sort: 'ttft', dir: SORT_DIRS.ttft, view: 'model', providers: [], archived: false }

    /**
     * One boolean as the three places that spell it write it: `true` in the
     * settings this browser kept, `1`/`true` in a hand-written URL, and the
     * guest read back from either. Anything else is off — including the string
     * `'0'`, which is a spelling of the default rather than of the filter.
     */
    function flagOf(value) {
      return value === true || value === 1 || value === '1' || value === 'true'
    }

    // --- localized copy ----------------------------------------------------------
    // The panel follows the host's locale service: its dictionaries are registered
    // under this package's namespace and read back through a bound translate
    // function, so the panel switches language together with the rest of the GUI,
    // and a language pack can override any key. Without that service — an older
    // host — the built-in Russian copy below keeps the panel complete.
    const I18N_NS = 'dsh-model-stats'
    const FALLBACK_LOCALE = 'ru'
    // The bundle's package name, and therefore the key `plugins.bundle.config`
    // dispatches on: the Plugins page asks for this bundle's page under the same
    // name the profile installed and the loader row carries.
    const BUNDLE_NAME = 'dsh-model-stats'

    const MESSAGES = {
      ru: {
        'panel.title': 'Скорость и стабильность моделей',
        'panel.subtitle':
          'По истории сессий. Отклик — до первого токена; tok/s e2e med — медианная скорость с учётом ожидания первого токена.',
        'sort.direction.asc': 'по возрастанию',
        'sort.direction.desc': 'по убыванию',
        'view.label': 'Вид',
        'view.switch': 'Переключить вид',
        'view.models': 'по моделям',
        'view.providers': 'по провайдерам',
        'columns.all': 'все метрики',
        'filter.label': 'Провайдеры',
        'filter.all': 'все',
        'filter.selection': '{selected} из {total}',
        'filter.note': 'выбрано провайдеров: {selected} из {total}',
        'filter.steps': 'шагов: {count}',
        'filter.reset': 'Сбросить',
        'filter.cap':
          'Больше {max} провайдеров сразу не сравнить: снимите отметку, чтобы выбрать другого.',
        'filter.empty': 'В истории пока нет ни одного провайдера.',
        // The panel's own name for the whole group, since the group now holds two
        // dimensions: the chip above it still names the provider half alone.
        'filter.group': 'Фильтр',
        'filter.archive': 'архив: модели вне конфигурации',
        'filter.archive.short': 'архив',
        'filter.archive.count': 'штук: {count}',
        'column.model': 'Модель',
        'column.provider': 'Провайдер',
        'column.steps': 'шагов',
        'column.ttft': 'отклик med',
        'column.tps': 'tok/s med',
        'column.errors': 'ош.',
        'column.errorRate': 'ош./100',
        'column.modelErrors': 'ош. модели',
        'column.interrupted': 'прервано',
        'column.ttftP90': 'отклик p90',
        'column.tpsMax': 'tok/s max',
        'column.confidence': 'замер',
        'column.llm': 'llm / шаг',
        'column.cache': 'кэш',
        'column.retry': 'ретраи',
        'column.ttftClean': 'отклик чист.',
        'column.e2e': 'tok/s e2e med',
        'column.prefill': 'префилл',
        'column.overhead': 'наш оверхед',
        'column.lastSeen': 'виден',
        'column.liveness': 'статус',
        'probe.label': 'Проверка',
        'action.liveness.all': 'Проверить все',
        'action.liveness.stale': 'Только устаревшие',
        'action.liveness.provider': 'Проверить провайдера',
        'liveness.status': 'Доступность модели сейчас',
        'hint.liveness':
          'Живость модели: зелёный кружок — отвечает, серый — не проверялась, пульсирующий — проверка идёт. Отказ выглядит по-разному, и разница в том, чей это ход. Жёлтый кружок — провайдер отказал из-за лимита: запрос дошёл, квота кончилась или сработала частота, поэтому дело не в модели, а в паузе или в пополнении баланса. Сплошной красный — проверка не удалась, отвечать некому: таймаут, обрыв связи, ошибка провайдера. Красный квадрат — строка не настроена, и чинить надо у себя: «нет доступа» — ключ не принят или его нет, «нет маршрута» — у провайдера не объявлен адрес, «нет модели» — такой модели у провайдера нет. Клик по кружку проверяет одну эту модель: проверка идёт тем же путём, что настоящий запрос, поэтому зелёный кружок означает, что харнесс до модели дотягивается. Если модель отвечала в истории позже последней проверки, неудачная проверка считается устаревшей, и кружок зелёный с пометкой «по истории». Обстоятельства проверки — время последнего запроса, время и длительность проверки, код отказа — напечатаны под кружком в режиме «все метрики» и всегда лежат в подсказке на самом кружке. Отказ, который панель не смогла классифицировать, печатает в клетке свой статус строчными: «timeout», «server», «http_500». Заголовок «статус» сортирует строки по тому же, что нарисовано в кружках: сверху то, что чинить срочно (красный квадрат, потом красный кружок, потом жёлтый), ниже доступные, а в самом низу — не проверенные; второй клик по заголовку переворачивает порядок.',
        'liveness.lastRequest': 'запрос {ago}',
        'liveness.checked': 'проверка {ago}',
        'liveness.unknown': 'не проверялась',
        'liveness.checking': 'проверяю…',
        'liveness.error': 'Проверка не удалась: {error}. Нажмите кружок у модели, чтобы повторить.',
        'liveness.up': 'доступна',
        'liveness.down': 'недоступна',
        'liveness.denied': 'нет доступа',
        'liveness.missing.route': 'нет маршрута',
        'liveness.missing.model': 'нет модели',
        'liveness.limited.quota': 'лимит исчерпан',
        'liveness.limited.rate': 'слишком часто',
        'liveness.byHistory': 'по истории',
        'liveness.fromHistoryTitle': 'проверка не удалась, но модель отвечала позже неё',
        'liveness.pending': 'проверяю ещё {count}',
        'liveness.summary': 'проверено {checked} из {total}',
        'announce.liveness.started': 'Проверяю доступность моделей…',
        'announce.liveness.done': 'Проверка завершена: доступно {ok} из {total}',
        'announce.liveness.none': 'Все модели уже проверены — нажмите «Проверить все», чтобы повторить',
        'hint.model':
          'Строка — одна модель, под именем указан её провайдер. Полный идентификатор модели — в подсказке на имени.',
        'hint.provider':
          'Строка — один провайдер: шаги и метрики всех его моделей вместе, поэтому числа здесь усреднены по провайдеру, а не по модели.',
        'hint.steps':
          'Сколько шагов пришлось на модель за всю историю сессий. Шаг — один запрос к модели, на который она ответила. Чем больше шагов, тем надёжнее остальные числа строки.',
        'hint.ttft':
          'Медиана времени до первого токена по шагам модели: сколько ждали начала ответа. Меньше — быстрее. Полоска под числом — его доля от самого большого отклика в столбце. Зелёным отмечен лучший результат среди показанных строк, красным — худший.',
        'hint.tps':
          'Медианная скорость генерации — сколько токенов ответа провайдер выдавал в секунду во время стриминга. Время ожидания первого токена и паузы вне стриминга сюда не входят; токены берутся из отчёта провайдера, а не считаются по фрагментам потока. Больше — быстрее. Полоска показывает долю от максимальной скорости среди видимых строк; зелёный цвет означает лучший результат, красный — худший.',
        'hint.errors':
          'Сколько раз запрос модели или её вызов инструмента закончились ошибкой за всю историю. Любое ненулевое значение подсвечено красным: это факт, а не сравнение с другими строками. Число включает ошибки запросов и вызовов инструментов за всю историю. Ненулевое значение подсвечивается красным. Подробности — коды и категории ошибок, а также число ошибок, вызванных моделью; ошибки гонки состояния файла означают изменение файла инструментом и не доказывают проблему модели.',
        'hint.errorRate':
          'Число ошибок на 100 шагов: нормализовано по активности, в отличие от общего счётчика. Это не процент неудачных запросов и не оценка качества модели: за шаг бывает несколько ошибок, а сложность задач и причины отказов различаются. Число не равно доле неудачных запросов: один шаг может содержать несколько ошибок, а причины ошибок бывают у модели, провайдера или самого харнесса.',
        'hint.modelErrors':
          'Сколько ошибок вызвано самим выводом модели: она назвала инструмент или аргументы, которых нет, либо её код не запустился. Гонки состояния файла, отказы песочницы, ошибки провайдера и служебные ошибки харнесса сюда не входят — их сменой модели не вылечить. Это число ошибок, которые непосредственно вызваны выводом модели, а не внешними причинами. Ненулевое значение подсвечивается красным.',
        'hint.interrupted':
          'Сколько шагов прервано на полпути. Это не ошибка модели и не отказ провайдера: ход прерван (смена пользователя, перехват, отмена). В агентном цикле прерванный шаг — потерянный шаг, поэтому ненулевое значение желтеет. Прерванный шаг — это незавершённый запрос, поэтому его результат и метрики могут быть неполными.',
        'hint.ttftP90':
          '90-й процентиль времени до первого токена: 90% измеренных шагов начали отвечать не позже этого времени, а 10% заняли столько же или больше. Большое значение показывает редкие медленные ответы.',
        'hint.tpsMax':
          'Максимальная скорость генерации в одном измеренном шаге, в токенах ответа в секунду во время стриминга. Это удачный единичный результат, а не типичная скорость модели.',
        'hint.confidence':
          'Доля шагов, где спана хватило для достоверной скорости: не короче 100 мс, не меньше 8 токенов и не меньше 4 фрагментов потока — иначе это один слипшийся пакет, а не генерация. Ниже 50% значение подсвечено жёлтым — tok/s по этой строке менее надёжен.',
        'hint.llm':
          'Средняя длительность шага: сколько времени занял запрос с ответом целиком, включая ожидание модели. Больше — дольше работает.',
        'hint.cache':
          'Доля входных токенов, прочитанных из кэша промпта. Выше — вход дешевле и быстрее; «-», если провайдер не сообщил о кэше.',
        'hint.retry':
          'Доля шагов, которым пришлось повторить запрос: провайдер отказал, и харнесс попробовал снова. Это доля шагов, а не доля попыток. Высокое значение означает нестабильный маршрут или отказы провайдера; низкое значение означает, что повторные запросы почти не требовались. Причина отказа может быть лимитом, ошибкой сервера или другой ошибкой провайдера. От 20% строка желтеет, от 33% краснеет. «-», если повторов не было вовсе.',
        'hint.ttftClean':
          'Медианное время до первого токена только для успешной попытки, без времени неудачных попыток и пауз между ними. Большая разница между этим значением и полным временем до первого токена означает, что задержку добавили повторы или провайдер, а не генерация ответа.',
        'hint.e2e':
          'Медианная сквозная скорость: токены ответа делятся на всё время от начала запроса до завершения стриминга, включая ожидание первого токена. Она показывает, как быстро вызывающий получает весь ответ; время неудачных попыток и пауз повторов также входит в ожидание..',
        'hint.prefill':
          'Доля времени от начала запроса до завершения ответа, которая прошла до появления первого токена. 0.3 — модель отвечает быстро, 0.85 — почти всё время уходит на префилл, и это уже не «модель думает», а провайдер. Доля вычисляется отдельно для каждого шага как время до первого токена, делённое на всё время до завершения ответа, затем берётся медиана. Значение 0,3 означает, что 30% времени ожидания пришлось на период до первого токена; значение 0,85 — что 85%. Чем выше доля, тем больше задержка до начала ответа.',
        'hint.overhead':
          'Время шага, которое не является ни ожиданием первого токена, ни стримингом: пауза между последним фрагментом ответа и закрывающим событием. Это единственная колонка, где чинить — нам: всё остальное в таблице зависит от провайдера. По всей истории это около 2% времени модели, но оно собрано неравномерно — у большинства моделей единицы миллисекунд, у отдельных сотни. От 200 мс строка желтеет.',
        'hint.lastSeen': 'Когда модель отвечала в последний раз — по всем сессиям в истории.',
        'hint.noStats':
          'Модель есть в текущей конфигурации, но в истории сессий нет ни одного её шага: все измерения строки пусты, а «0» в столбце шагов — это замер, а не пропуск (шагов не было ни одного). Проверить модель можно кружком в столбце «статус»: проверка идёт тем же путём, что настоящий запрос, поэтому зелёный кружок означает, что харнесс до модели дотягивается. Такие строки стоят внизу таблицы, пока по ним нет ни одного измерения.',
        'noStats.badge': 'нет статистики',
        'hint.archive':
          'Модели нет в текущей конфигурации: харнесс её сейчас не обслуживает, поэтому по умолчанию она в архив не попадает.',
        'archive.badge': 'архив',
        'action.refresh': 'Обновить',
        'action.refreshing': 'обновляю…',
        'loading.body':
          'Считаю статистику по истории сессий… Первый в этой установке проход читает все логи сессий и может занять до минуты. Дальше ответ берётся из кэша сразу, а свежие данные догружаются в фоне.',
        'empty.pending':
          'Прочитано {scanned} сессий, ещё {pending} в очереди — данные появятся по мере обработки.',
        'empty.nodata':
          'В истории пока нет замеров. Поработайте в сессии — метрики считаются по уже записанным логам.',
        'empty.filtered':
          'У выбранных провайдеров в истории нет замеров. Снимите фильтр или отметьте другого провайдера.',
        'empty.archived':
          'Показывать нечего: {count} моделей вне текущей конфигурации лежат в архиве. Отметьте «{archive}» в фильтре, чтобы их увидеть.',
        'error.body':
          'Не удалось получить статистику: {error}. Нажмите «Обновить», чтобы повторить.',
        'error.network': 'хост не ответил',
        'warn.body':
          'Не удалось обновить данные: {warning}. Показаны последние полученные значения — нажмите «Обновить», чтобы повторить.',
        'warn.stale':
          'Не удалось получить порядок «{sort}»{filter}: {warning}. Показаны строки прежнего запроса — нажмите «Обновить», чтобы повторить.',
        'status.updating':
          'Показан прежний ответ — обновляю «{sort}»{filter}. Обычно это доли секунды.',
        'timeout.reason': 'превышено время ожидания ответа ({seconds} с)',
        'announce.refreshing': 'Обновляю статистику…',
        'announce.updated': 'Статистика обновлена',
        'announce.sorted': 'Порядок строк: {column}, {direction}.',
        'footer.scanned': 'сессий в отчёте: {count}',
        'footer.skipped': 'пропущено: {count}',
        'footer.steps': 'шагов: {count}',
        'footer.models': 'моделей: {count}',
        'footer.readNow': 'прочитано сейчас: {count}',
        'footer.reused': 'из кэша: {count}',
        'footer.pending': 'обновляю ещё {count}',
        'footer.snapshot': 'снимок {ago}',
        'footer.shown.models': 'в таблице: {count} моделей, {steps} шагов',
        'footer.shown.providers': 'в таблице: {count} провайдеров, {steps} шагов',
        'footer.archive': 'в архиве: {count}',
        'footer.noStats': 'без статистики: {count}',
        'legend.summary': 'Как читать таблицу',
        'note.core':
          'Зелёным отмечены лучшие медианы, красным — худшие среди показанных строк. Значение «-» означает, что провайдер не записал тайминги потока для этой модели, а не что она медленная. Наведите курсор на заголовок столбца, чтобы прочитать, что он измеряет. Заголовок — кнопка сортировки: щёлкните, чтобы упорядочить строки по нему, ещё раз — чтобы развернуть порядок. Под откликом и tok/s нарисована полоска: доля значения от наибольшего в этом столбце. ',
        'note.extra':
          '«замер» — доля шагов, где спана хватило для достоверной скорости: низкое значение значит, что модель в основном отдавала очень короткие порции, и tok/s по ней менее надёжен. «кэш» — доля чтения из кэша промпта во входных токенах. «виден» — когда модель последний раз отвечала.',
        'note.collapsed':
          'Отклик p90, tok/s max, «замер», llm / шаг, «кэш» и «виден» — за кнопкой «все метрики».',
      },
      en: {
        'panel.title': 'Model speed and stability',
        'panel.subtitle':
          'From session history. Response is time to first token; tok/s e2e med is median throughput including the first-token wait.',
        'sort.direction.asc': 'ascending',
        'sort.direction.desc': 'descending',
        'view.label': 'View',
        'view.switch': 'Switch view',
        'view.models': 'By Model',
        'view.providers': 'By Provider',
        'columns.all': 'All Metrics',
        'filter.label': 'Providers',
        'filter.all': 'all',
        'filter.selection': '{selected} of {total}',
        'filter.note': 'providers selected: {selected} of {total}',
        'filter.steps': 'steps: {count}',
        'filter.reset': 'Reset',
        'filter.cap':
          'More than {max} providers cannot be compared at once: clear one to pick another.',
        'filter.empty': 'No provider in the history yet.',
        'filter.group': 'Filter',
        'filter.archive': 'archive: models outside the configuration',
        'filter.archive.short': 'archive',
        'filter.archive.count': 'in it: {count}',
        'column.model': 'Model',
        'column.provider': 'Provider',
        'column.steps': 'steps',
        'column.ttft': 'response med',
        'column.tps': 'tok/s med',
        'column.errors': 'errors',
        'column.errorRate': 'err/100',
        'column.modelErrors': 'model err',
        'column.interrupted': 'interrupted',
        'column.ttftP90': 'response p90',
        'column.tpsMax': 'tok/s max',
        'column.confidence': 'meas.',
        'column.llm': 'llm / step',
        'column.cache': 'cache',
        'column.retry': 'retries',
        'column.ttftClean': 'response clean',
        'column.e2e': 'tok/s e2e med',
        'column.prefill': 'prefill',
        'column.overhead': 'our overhead',
        'column.lastSeen': 'seen',
        'column.liveness': 'status',
        'probe.label': 'Check',
        'action.liveness.all': 'Check All',
        'action.liveness.stale': 'Check Stale Only',
        'action.liveness.provider': 'Check Provider',
        'liveness.status': 'Model availability right now',
        'hint.liveness':
          'Model liveness: a green circle answers, grey was never checked, a pulsing circle means a check is running. A refusal looks different, and the difference is whose move it is. Amber is the provider refusing on a limit: the request arrived and was refused on quota or rate, so the fix is a pause or a top-up, not another model. Solid red is a check that failed with nobody to answer it — a timeout, a dropped connection, a provider error. A filled red square is a row that is not configured, and the fix is on this side: “no access” means the key was refused or is missing, “no route” that the provider has no endpoint declared, “no model” that the provider does not know this model. Clicking a circle checks that one model: the check takes the same route a real request does, so a green circle means the harness itself can reach the model. When the model answered in history after the last check, a failed check is treated as stale and the circle is green, marked “from history”. What the check saw — last request, check time and latency, failure code — is printed under the circle in “all metrics” and always sits in the circle’s tooltip. A failure the panel cannot classify prints its own status in the cell, in lower case: “timeout”, “server”, “http_500”. The “status” heading sorts by exactly what the circles show: the rows to fix first on top (the red square, then the red circle, then amber), the available ones below them, and the never-checked at the very bottom; a second click on the heading turns the order around.',
        'liveness.lastRequest': 'request {ago}',
        'liveness.checked': 'checked {ago}',
        'liveness.unknown': 'not checked',
        'liveness.checking': 'checking…',
        'liveness.error': 'Check failed: {error}. Click the model’s circle to retry.',
        'liveness.up': 'available',
        'liveness.down': 'unavailable',
        'liveness.denied': 'no access',
        'liveness.missing.route': 'no route',
        'liveness.missing.model': 'no model',
        'liveness.limited.quota': 'out of quota',
        'liveness.limited.rate': 'rate limited',
        'liveness.byHistory': 'from history',
        'liveness.fromHistoryTitle': 'the check failed, but the model answered after it',
        'liveness.pending': 'checking {count} more',
        'liveness.summary': 'checked {checked} of {total}',
        'announce.liveness.started': 'Checking model availability…',
        'announce.liveness.done': 'Check finished: {ok} of {total} available',
        'announce.liveness.none': 'Every model is already checked — press “Check all” to repeat',
        'hint.model':
          'One row is one model, with its provider under the name. The full model id is in the tooltip on the name.',
        'hint.provider':
          'One row is one provider: the steps and metrics of all of its models together, so these figures are averaged over the provider, not over one model.',
        'hint.steps':
          'How many steps this model took across the whole session history. A step is one request to a model that answered. The more steps, the more reliable the rest of the row.',
        'hint.ttft':
          'Median time from request start to the first non-empty response token. Lower is faster. The bar shows the value relative to the largest visible value; green marks the fastest result and red the slowest.',
        'hint.tps':
          'Median generation rate: provider-reported response tokens per second during streaming. Waiting for the first token and pauses outside streaming are excluded; tokens are not counted from stream fragments. Higher is faster. The bar shows the value relative to the fastest visible value; green marks the fastest result and red the slowest.',
        'hint.errors':
          'How many times a request to this model, or one of its tool calls, ended in an error, over the whole history. Any non-zero value is red: that is a fact, not a comparison with the other rows. The count includes failed requests and tool calls across the whole history. Non-zero is red. Details include error codes and categories and whether the model caused them; a filesystem state race means a tool found that a file changed and does not by itself indicate a model fault.',
        'hint.errorRate':
          'Error events per 100 steps, normalized for activity rather than a raw total. Not a failed-request percentage or a model-quality score: a step may have several errors, and task difficulty and causes differ. It is not a failed-request percentage or a model-quality score: one step can contain several errors, and causes include the model, provider and harness.',
        'hint.modelErrors':
          'How many errors were caused by the model’s own output: it named a tool or arguments that do not exist, or the code it wrote failed to run. Filesystem state races, sandbox denials, provider faults and harness bookkeeping are excluded — no change of model cures those. These are errors directly caused by the model’s output, rather than by external systems. Red when non-zero.',
        'hint.interrupted':
          'How many steps were interrupted part-way. Not a model error and not a provider refusal: the turn was taken over or cancelled. In an agent loop an interrupted step is a wasted step, so a non-zero value turns the row amber. An interrupted step is an unfinished request, so its result and measurements may be incomplete.',
        'hint.ttftP90':
          '90th percentile of time to first token: 90% of measured steps started no later than this time and 10% took this long or longer. A high value shows rare slow starts.',
        'hint.tpsMax':
          'Maximum generation rate measured in one step, in response tokens per second during streaming. It is a single favorable result, not the model’s typical rate.',
        'hint.confidence':
          'Share of steps whose span was long enough for a reliable rate: at least 100 ms, at least 8 tokens and at least 4 stream fragments — below that it is one packed burst, not a generation. Below 50% is marked yellow — the row’s tok/s is the least trustworthy number in it.',
        'hint.llm':
          'Average step duration: how long the request with its answer took end to end, including the wait for the model. More means it works longer.',
        'hint.cache':
          'Share of input tokens read from the prompt cache. Higher means the input is cheaper and faster to send; “-” when the provider reported no cache.',
        'hint.retry':
          'Share of steps that had to repeat their request because the provider refused an attempt. This is a share of steps, not of attempts. A high value indicates an unstable route or provider refusals; causes may include quota limits, server errors or other provider faults. The row turns amber from 20% and red from 33%. “-” when nothing was ever retried.',
        'hint.ttftClean':
          'Median time to first token for the successful attempt only, excluding failed attempts and pauses between attempts. A large difference from the full time to first token means retries or the provider, rather than response generation, added delay.',
        'hint.e2e':
          'Median end-to-end generation rate: response tokens divided by all time from request start through streaming completion, including time to first token. It shows how quickly the caller receives the complete response; failed attempts and retry pauses are included in the wait.',
        'hint.prefill':
          'Median share of the time from request start through response completion that elapsed before the first token. It is computed per step before taking the median: 0.3 means 30% of the wait was before output began; 0.85 means 85%. Higher means more delay before the response starts.',
        'hint.overhead':
          'Time in the step that is neither the wait for the first token nor the streaming: the gap between the last delta and the event that closed the step. This is the one column whose fix is on this side — everything else in the table belongs to the provider. Across this history it is about 2% of model time, but it is not spread evenly: units of milliseconds for most models, hundreds for a few. The row turns amber from 200 ms.',
        'hint.lastSeen': 'When the model last answered, across every session in the history.',
        'hint.noStats':
          'The model is in the current configuration, but no session has ever run a step of it: every measurement in the row is empty, and the “0” in the steps column is a measurement rather than a gap (not one step was ever recorded). The circle in the “status” column is how to test it — the check takes the same route a real request does, so a green circle means the harness itself reaches the model. Such rows sit at the bottom of the table for as long as nothing about them has been measured.',
        'noStats.badge': 'no statistics',
        'hint.archive':
          'The model is not in the current configuration: the harness does not serve it now, so it is kept in the archive and left out by default.',
        'archive.badge': 'archive',
        'action.refresh': 'Refresh',
        'action.refreshing': 'refreshing…',
        'loading.body':
          'Counting over session history… The first pass in this install reads every session log and can take up to a minute. After that the answer comes from the cache immediately and fresh data is loaded in the background.',
        'empty.pending':
          'Read {scanned} sessions, {pending} still queued — rows appear as they are processed.',
        'empty.nodata':
          'No measurements in the history yet. Work in a session — metrics are folded from logs that are already written.',
        'empty.filtered':
          'The selected providers have no measurements in the history. Clear the filter or pick another provider.',
        'empty.archived':
          'Nothing to show: {count} models are outside the current configuration and sit in the archive. Tick “{archive}” in the filter to see them.',
        'error.body': 'Could not get the statistics: {error}. Press “Refresh” to retry.',
        'error.network': 'the host did not answer',
        'warn.body':
          'Could not refresh: {warning}. Showing the last values received — press “Refresh” to retry.',
        'warn.stale':
          'Could not load the “{sort}”{filter} order: {warning}. Showing the previous query’s rows — press “Refresh” to retry.',
        'status.updating':
          'Showing the previous answer — updating the “{sort}”{filter} order. This usually takes a moment.',
        'timeout.reason': 'the request timed out ({seconds} s)',
        'announce.refreshing': 'Refreshing statistics…',
        'announce.updated': 'Statistics updated',
        'announce.sorted': 'Row order: {column}, {direction}.',
        'footer.scanned': 'sessions in report: {count}',
        'footer.skipped': 'skipped: {count}',
        'footer.steps': 'steps: {count}',
        'footer.models': 'models: {count}',
        'footer.readNow': 'read now: {count}',
        'footer.reused': 'from cache: {count}',
        'footer.pending': 'refreshing {count} more',
        'footer.snapshot': 'snapshot {ago}',
        'footer.shown.models': 'in table: {count} models, {steps} steps',
        'footer.shown.providers': 'in table: {count} providers, {steps} steps',
        'footer.archive': 'in archive: {count}',
        'footer.noStats': 'without statistics: {count}',
        'legend.summary': 'How to read the table',
        'note.core':
          'Green marks the best medians, red the worst among the rows shown. A “-” means the provider recorded no stream timing for that model, not that the model is slow. Hover a column heading to read what it measures. A heading is a sort control: click it to order the rows by that column, click it again to reverse the order. Under response and tok/s there is a bar: that value’s share of the largest one in the column. ',
        'note.extra':
          '“meas.” is the share of steps whose span was long enough to be a reliable rate: a low value means the model mostly emitted very short bursts, so its tok/s is the least trustworthy number in the row. “cache” is the prompt-cache read share of input tokens. “seen” is when the model last answered.',
        'note.collapsed':
          'Response p90, tok/s max, “meas.”, llm / step, “cache” and “seen” — behind the “all metrics” button.',
      },
    }

    /**
     * A failure as one sentence.
     *
     * A rejected `fetch` is the browser failing to reach the host at all, and its
     * own message — "Failed to fetch" — is developer English dropped into the
     * middle of a translated sentence. Anything the host itself said is worth
     * repeating as it stands.
     */
    function failureReason(error, t) {
      if (error instanceof TypeError) return t('error.network')
      return String(error?.message ?? error)
    }

    /** `{name}` interpolation, the same dictionary format the host service uses. */
    function interpolate(template, params) {
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        name in params ? String(params[name]) : match,
      )
    }

    /** Translator used when the host has no locale service. */
    function fallbackTranslate(key, params) {
      return interpolate(MESSAGES[FALLBACK_LOCALE][key] ?? key, params)
    }

    /**
     * Bind this package's copy to the host's locale service.
     *
     * Resolved lazily — on the first label or render, not at plugin apply — so
     * the panel still finds the service when it is provided later in the boot
     * sequence. Any failure keeps the built-in copy rather than keying the panel
     * to raw dictionary ids.
     */
    function bindPanelLocale(ctx) {
      const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
      const usable =
        locale !== undefined &&
        typeof locale.register === 'function' &&
        typeof locale.bind === 'function'
      if (!usable) return { t: fallbackTranslate, locale: undefined }
      const register = (tag, dict) => {
        const call = () => locale.register(I18N_NS, tag, dict)
        if (typeof ctx.effect === 'function') ctx.effect(call, `${I18N_NS}: ${tag}`)
        else call()
      }
      try {
        register('ru', MESSAGES.ru)
        register('en', MESSAGES.en)
        return { t: locale.bind(I18N_NS), locale }
      } catch (error) {
        return { t: fallbackTranslate, locale: undefined }
      }
    }

    // --- formatting helpers ------------------------------------------------------
    // Numbers and times follow the active language too, so a Russian sentence in
    // the Russian UI says "45,2", not "45.2".
    const dash = '-'
    /** Between a number and its unit: "820 ms" must not wrap into two lines. */
    const NBSP = '\u00A0'
    /** A stable empty set, so "no probe is running" is one identity, not a new Set per render. */
    const EMPTY_SET = new Set()

    function finite(value) {
      return value !== null && value !== undefined && Number.isFinite(value)
    }

    /** Intl formatters are expensive to build, so they are cached per language. */
    const formatterBundles = new Map()

    function formattersFor(locale) {
      const cached = formatterBundles.get(locale)
      if (cached !== undefined) return cached

      // An unknown or malformed tag must not take the panel down with it.
      let resolved = locale
      try {
        new Intl.NumberFormat(resolved)
      } catch (error) {
        resolved = FALLBACK_LOCALE
      }

      const decimals = new Map()
      const decimalFormat = (digits) => {
        let format = decimals.get(digits)
        if (format === undefined) {
          format = new Intl.NumberFormat(resolved, {
            minimumFractionDigits: digits,
            maximumFractionDigits: digits,
          })
          decimals.set(digits, format)
        }
        return format
      }

      const relative = new Intl.RelativeTimeFormat(resolved, { numeric: 'auto' })

      const bundle = {
        num(value, digits) {
          if (!finite(value)) return dash
          return decimalFormat(digits).format(value)
        },
        /** Counts are grouped, never fractional: 12 345 steps, not 12345. */
        count(value) {
          if (!finite(value)) return dash
          return decimalFormat(0).format(value)
        },
        ms(value) {
          if (!finite(value)) return dash
          if (value < 1000) return `${decimalFormat(0).format(Math.round(value))}${NBSP}ms`
          return `${decimalFormat(1).format(value / 1000)}${NBSP}s`
        },
        pct(value) {
          if (!finite(value)) return dash
          return `${decimalFormat(1).format(value * 100)}%`
        },
        // numeric:'auto' yields "сейчас" for a snapshot taken moments ago and the
        // correct plural everywhere else, in every language Intl knows.
        ago(ts) {
          if (!Number.isFinite(ts)) return dash
          const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000))
          if (seconds < 60) return relative.format(-seconds, 'second')
          if (seconds < 3600) return relative.format(-Math.round(seconds / 60), 'minute')
          if (seconds < 86400) return relative.format(-Math.round(seconds / 3600), 'hour')
          return relative.format(-Math.round(seconds / 86400), 'day')
        },
      }
      formatterBundles.set(locale, bundle)
      return bundle
    }

    // Local model ids are filesystem paths, e.g.
    // /Users/jeka/.lmstudio/models/ornith-ai/Ornith-1.5-9B-GGUF/Ornith-1.5-9B-Q4_K_M.gguf
    // A path that long cannot be shown whole in a table column, so the last
    // segment is displayed and the full id stays in the tooltip (and in the
    // agent's text report, which is unchanged).
    const MAX_LABEL = 44

    // How many rows the panel asks the route for: its own maximum (the route
    // clamps `limit` to 200).
    //
    // The page used to be whatever the route defaulted to — 50 rows. That was
    // the right bound while the table was the history: 50 rows is a ranked
    // shortlist, and the ranking is what a reader wants from it. It stopped being
    // the right bound when the table also began to list the models the
    // configuration serves and no session has ever run (a configured pair with no
    // statistics is a row, so that it can be seen and tested). Measured on this
    // machine by driving the shipped host half against its own snapshot, with the
    // probe store (137 pairs over 16 providers) standing in for the live catalog:
    // the answer is 141 rows — 60 with history and 81 without — in 183 KB of
    // JSON, in 73 ms. Those 81 sort *last* under the panel's own default
    // (fastest response first), and at the old page size the same answer carried
    // none of them: `limit=50` returned 50 rows, every one with history. The
    // whole set is asked for in one request instead, and the table scrolls.
    const PAGE_ROWS = 200

    // The host bounds its own panel answer (PANEL_BUDGET_MS, 2.5 s in this tree)
    // and returns partial work, which the refresh loop then polls for. This
    // deadline is only the point where a host that is not answering at all
    // becomes something the user can act on: well above that budget plus the
    // corpus listing, and still bounded. It was 25 s, which was below the 47-56 s
    // answer time measured on a host running an older build of the plugin — and
    // a panel that aborts a request the host is still working on reports an
    // error where it would otherwise have had data.
    const REQUEST_TIMEOUT_MS = 60000

    // The last successful answer is kept in the browser so opening the panel
    // shows the table at once instead of a spinner, then refreshes behind it.
    // The host folds in the background either way; this only removes the wait
    // from the first paint.
    const STORE_KEY = 'dsh-model-stats:v1'
    const STORE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
    const REFRESH_INTERVAL_MS = 1500
    const MAX_REFRESHES = 20

    /**
     * The identity of one query: `sort.dir|view|providers|archive`.
     *
     * It names a cache entry and it labels the rows a payload answers. The panel
     * needs the second job because a switch to another sort — or to another set
     * of providers — has no answer yet, and what is on screen in the meantime
     * belongs to a query the user is no longer asking for. The direction is part
     * of the identity and not a detail of it: the same key in the other
     * direction is a different table, and answering it from a cache entry that
     * was stored the other way round would show rows in an order nobody asked
     * for, under an arrow claiming that order. The provider part is empty for
     * the unfiltered question, so the key of "every provider" stays readable
     * rather than becoming a list of nothing — and the archive part is absent
     * while the archive is off, so the default query keeps the key it had before
     * this filter existed and a table cached by an older build is still a hit.
     */
    function queryKey(sort, dir, view, providers, archived) {
      const base = `${sort}.${dir}|${view}|${normalizeProviders(providers).join(',')}`
      return archived === true ? `${base}|archive` : base
    }

    /** Best-effort read: a broken or unavailable store must never break the panel. */
    function readCache() {
      try {
        const raw = window.localStorage.getItem(STORE_KEY)
        if (raw === null) return {}
        const parsed = JSON.parse(raw)
        const entries = parsed?.entries
        return entries !== null && typeof entries === 'object' ? entries : {}
      } catch {
        return {}
      }
    }

    function readCachedPayload(sort, dir, view, providers, archived) {
      const entry = readCache()[queryKey(sort, dir, view, providers, archived)]
      if (entry === null || typeof entry !== 'object') return null
      if (typeof entry.at !== 'number' || Date.now() - entry.at > STORE_MAX_AGE_MS) return null
      const data = entry.data
      if (data === null || typeof data !== 'object' || data.ok !== true) return null
      if (!Array.isArray(data.rows)) return null
      return data
    }

    function writeCachedPayload(sort, dir, view, providers, archived, data) {
      try {
        const entries = readCache()
        entries[queryKey(sort, dir, view, providers, archived)] = { at: Date.now(), data }
        // A handful of keys is enough for a session; old ones would only grow.
        const keys = Object.keys(entries)
        for (const key of keys.slice(0, Math.max(0, keys.length - 4))) delete entries[key]
        window.localStorage.setItem(STORE_KEY, JSON.stringify({ entries }))
      } catch {
        // A full or disabled store is not the panel's problem.
      }
    }

    // How the panel is set up is the user's choice, not a cache: it lives in its
    // own key so that dropping the payload cache can never drop the preferences.
    const PREFS_KEY = 'dsh-model-stats:prefs:v1'

    /**
     * The provider selection, as a list of exact names.
     *
     * Read from three places and normalized once: the host's answer (an array),
     * the panel's own query string, and whatever the browser kept from a
     * previous session. Order is not part of the question — `a,b` and `b,a` are
     * the same filter — so the list is sorted, de-duplicated and bounded before
     * it becomes a key or a URL. A value that is not a name at all (a number, a
     * nested array, a 200-entry list from a corrupted store) is dropped rather
     * than sent: the host answers a filter it cannot match with the whole
     * table, which is the one result a filter must never produce silently.
     */
    const MAX_PROVIDERS = 24

    function normalizeProviders(value) {
      const raw =
        Array.isArray(value) ? value : typeof value === 'string' && value !== '' ? value.split(',') : []
      const names = []
      for (const entry of raw) {
        if (typeof entry !== 'string') continue
        const name = entry.trim()
        if (name !== '' && !names.includes(name)) names.push(name)
      }
      return names.sort().slice(0, MAX_PROVIDERS)
    }

    /** Best-effort read, same contract as the payload cache. */
    function readPrefs() {
      try {
        const raw = window.localStorage.getItem(PREFS_KEY)
        if (raw === null) return {}
        const parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' ? parsed : {}
      } catch {
        return {}
      }
    }

    function writePrefs(patch) {
      try {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify({ ...readPrefs(), ...patch }))
      } catch {
        // A full or disabled store is not the panel's problem.
      }
    }

    /**
     * One raw source of the question — the address, or the settings this browser
     * kept — read as a query, with `fallback` filling every hole. A stale or
     * corrupt value must never reach the host as a query.
     *
     * The key is checked against every order the table can show, not against the
     * five preset buttons: a column heading is a sort control too, so a store
     * that kept `sort: cache` from yesterday is a perfectly good preference. The
     * direction is checked on its own — it is a direction or it is not, whatever
     * key it was written under.
     */
    function queryFrom(raw, fallback) {
      const source = raw !== null && typeof raw === 'object' ? raw : {}
      const known = Object.prototype.hasOwnProperty.call(SORT_DIRS, source.sort)
      const sort = known ? source.sort : fallback.sort
      const dir =
        source.dir === 'asc' || source.dir === 'desc'
          ? source.dir
          : (SORT_DIRS[sort] ?? fallback.dir)
      return {
        sort,
        dir,
        view: source.view === 'provider' ? 'provider' : fallback.view,
        providers:
          source.providers === undefined || source.providers === null
            ? fallback.providers
            : normalizeProviders(source.providers),
        // A boolean from the settings and a string from the address are one
        // value here: the archive is on or it is off, and a corrupt value must
        // not reach the host as a query — an unreadable preference falls back to
        // the default rather than turning the filter on.
        archived:
          source.archived === undefined || source.archived === null
            ? fallback.archived === true
            : flagOf(source.archived),
      }
    }

    // --- the question in the address ---------------------------------------------
    // What the panel shows is worth a link: the same table can be handed to
    // someone else, kept in a bookmark, or read off the address bar. The five keys
    // are namespaced because the address belongs to the host's page — the panel
    // touches only its own, and leaves everything else in the query string
    // exactly as it found it.
    const URL_KEYS = {
      sort: 'msSort',
      dir: 'msDir',
      view: 'msView',
      providers: 'msProvider',
      archived: 'msArchived',
    }

    /** What the address asks for, or null when it names no question of ours. */
    function readUrlQuery() {
      try {
        if (typeof window === 'undefined' || typeof window.location?.search !== 'string') return null
        const params = new URLSearchParams(window.location.search)
        if (!Object.values(URL_KEYS).some((name) => params.has(name))) return null
        return {
          sort: params.get(URL_KEYS.sort) ?? undefined,
          dir: params.get(URL_KEYS.dir) ?? undefined,
          view: params.get(URL_KEYS.view) ?? undefined,
          providers: params.get(URL_KEYS.providers) ?? undefined,
          archived: params.get(URL_KEYS.archived) ?? undefined,
        }
      } catch (error) {
        // A host that guards its address is not the panel's problem: the question
        // then simply comes from the settings below.
        return null
      }
    }

    /**
     * The question the panel opens with: the address first — it is the more
     * specific statement, and the one a reader typed or followed — then the last
     * choice this browser kept, then the defaults.
     */
    function readInitialQuery() {
      const url = readUrlQuery()
      const prefs = readPrefs()
      const pick = (key) => (url !== null && url[key] !== undefined ? url[key] : prefs[key])
      return queryFrom(
        {
          sort: pick('sort'),
          dir: pick('dir'),
          view: pick('view'),
          providers: pick('providers'),
          archived: pick('archived'),
        },
        DEFAULT_QUERY,
      )
    }

    /**
     * Write the question into the address, beside whatever the host keeps there.
     *
     * Only a choice the reader made reaches this — never an effect keyed on the
     * value, which would rewrite the address of a panel nobody touched.
     * `replaceState` rather than a push: the address names what is on screen, it
     * is not a trail of pages to go Back through.
     */
    function writeUrlQuery(sort, dir, view, providers, archived) {
      try {
        const href = typeof window === 'undefined' ? undefined : window.location?.href
        if (typeof href !== 'string' || typeof window.history?.replaceState !== 'function') return
        const url = new URL(href)
        url.searchParams.set(URL_KEYS.sort, sort)
        url.searchParams.set(URL_KEYS.dir, dir)
        url.searchParams.set(URL_KEYS.view, view)
        if (providers.length > 0) url.searchParams.set(URL_KEYS.providers, providers.join(','))
        else url.searchParams.delete(URL_KEYS.providers)
        // The default has no spelling in the address, for the reason the empty
        // provider selection has none: a link carries what the reader asked for,
        // and "the archive is off" is what a link without the key already says.
        if (archived === true) url.searchParams.set(URL_KEYS.archived, '1')
        else url.searchParams.delete(URL_KEYS.archived)
        window.history.replaceState(null, '', url)
      } catch (error) {
        // A guarded or unmovable address is not the panel's problem.
      }
    }

    // --- panel state -------------------------------------------------------------
    // The state machine is four pure functions, written out rather than inlined
    // into the component so that `tools/verify-panel-state.mjs` can drive the
    // real panel through them. They exist because of one rule:
    //
    //   rows already on screen are never replaced by a message.
    //
    // Switching the sort asks a question the host has not answered yet, so the
    // panel has a choice: blank itself, or keep what it has. It keeps it. Losing
    // the table is the one outcome the user cannot act on — and if that request
    // is slow, fails, or is aborted by a following click, the table did not come
    // back on its own. `dataQuery` records which query the visible rows answer,
    // so the panel can name the wait instead of passing off a stale order as the
    // requested one.
    const EMPTY_STATE = { phase: 'loading', data: null, dataQuery: null, warning: null, error: null }

    /** The state a switch to `key` starts from: cached answer, kept rows, or nothing. */
    function querySwitched(prev, cached, key) {
      const fresh = cached ?? null
      if (fresh !== null) return { phase: 'ready', data: fresh, dataQuery: key, warning: null, error: null }
      if (prev.data === null || prev.data === undefined) return EMPTY_STATE
      return { ...prev, phase: 'loading', warning: null, error: null }
    }

    /** The state an answer for `key` puts the panel in. */
    function queryAnswered(data, key) {
      return { phase: 'ready', data, dataQuery: key, warning: null, error: null }
    }

    /** The state a failed request puts the panel in. Rows survive a failure. */
    function queryFailed(prev, message) {
      if (prev.data === null || prev.data === undefined) {
        return { phase: 'error', data: null, dataQuery: null, warning: null, error: message }
      }
      return { ...prev, phase: 'ready', warning: message, error: null }
    }

    /** Which block the panel renders. Rows win over every message. */
    function contentKind(rows, state) {
      if (rows.length > 0) return 'table'
      if (state.phase === 'error') return 'error'
      if (state.phase === 'loading' || state.phase === 'refreshing') return 'loading'
      return 'empty'
    }

    function shortLabel(id) {
      if (typeof id !== 'string' || id.length <= MAX_LABEL) return id
      const segments = id.split('/').filter((part) => part !== '')
      const tail = segments.length > 0 ? segments[segments.length - 1] : id
      if (segments.length > 1 && tail.length >= 8 && tail.length <= MAX_LABEL) {
        return `…/${tail}`
      }
      // A long single token has no informative segment: keep both ends.
      return `${id.slice(0, 20)}…${id.slice(-20)}`
    }

    // --- columns -----------------------------------------------------------------
    // Declared once and consumed by both the header and the body, so a metric's
    // label, its cell and its position cannot drift apart between the two.
    //
    // `core` columns are what the panel shows by default. The panel lives on this
    // bundle's page in the Plugins section — wider than the settings dialog it
    // came from — but ten columns of `white-space: nowrap` numbers still compete
    // for the width the page gives them, so the `extra` columns hold the deeper
    // numbers and stay one click away: nothing is dropped, only deferred, and the
    // table as it opens is the question it answers.
    //
    // `base` is the class of an ordinary cell ('num' = primary, otherwise dim),
    // `tone` may override it per row (best median, worst median, error, low
    // confidence).
    //
    // `hintKey` is what the heading explains on hover, and — because a `title`
    // is a mouse-only affordance — what it also carries as visually hidden
    // text, so the same sentence reaches a keyboard or screen-reader user.
    //
    // `sort` is the host order this column is sorted by when its heading is
    // clicked, and the column becomes a button: a heading the reader can see
    // sort the table by is the same control as a preset in the toolbar, spelled
    // where the numbers are. Every column declares one, so a heading that looks
    // like a control is one — a dead heading is worse than no heading.
    const COLUMN_DEFINITIONS = [
      {
        key: 'name',
        align: 'left',
        sort: 'name',
        labelKey: (view) => (view === 'model' ? 'column.model' : 'column.provider'),
        hintKey: (view) => (view === 'model' ? 'hint.model' : 'hint.provider'),
        cell: (row, ctx) => {
          const full = ctx.view === 'model' ? row.model : row.provider
          const short = ctx.view === 'model' ? shortLabel(row.model) : row.provider
          return h(
            'div',
            { className: 'dsh-ms-model-inner' },
            h(
              'span',
              { className: 'dsh-ms-model-name', title: full, translate: 'no' },
              short,
              // The tooltip carries the full id for the mouse. A shortened label
              // must not be the only thing everyone else can reach.
              short === full ? null : h('span', { className: 'dsh-ms-sr-only' }, ` — ${full}`),
            ),
            // No tooltip on the provider: the name is right there and it wraps,
            // so a title would only repeat it — and a machine name is not a
            // phrase to hand to a translator.
            ctx.view === 'model'
              ? h('span', { className: 'dsh-ms-provider', translate: 'no' }, row.provider)
              : null,
            // The mark is what makes the archive usable: with the filter on, the
            // table holds two kinds of row, and without a word on the retired
            // ones the reader would take them for candidates. It comes last
            // because the name and the route are what the cell is for, and a
            // footnote above them would push the route down on exactly the rows
            // that are already the exception. `archived` is only ever `true` on a
            // row the host could actually grade, so a host that could not read
            // the configuration marks nothing.
            row.archived === true
              ? h(
                  'span',
                  { className: 'dsh-ms-archive', title: ctx.t('hint.archive') },
                  ctx.t('archive.badge'),
                )
              : null,
            // The other half of one statement. A row the configuration serves
            // and no session has ever used is in the table so that it can be seen
            // and tested, and every figure in it but the step count is a dash —
            // which on its own reads as "the provider recorded nothing", the one
            // reading that is not true of it. The mark says which kind of row
            // this is, and its tooltip is where the reader is told that the
            // circle in the status column is the way to try the model.
            row.noStats === true
              ? h(
                  'span',
                  { className: 'dsh-ms-nostats', title: ctx.t('hint.noStats') },
                  ctx.t('noStats.badge'),
                )
              : null,
          )
        },
      },
      // The status column stands second, next to the name it belongs to. It is
      // the one column that is always shown, and the one cell a reader acts on —
      // so it sits where the eye starts rather than off the end of a wide table,
      // behind the one part of the table nobody scrolls to.
      {
        key: 'liveness',
        tier: 'extra',
        align: 'left',
        // Sorting by it is a triage order, not a measurement: what is broken
        // first, and at the bottom the rows nobody has checked — which is the
        // answer to "what is wrong right now" in one click. The host ranks it
        // (`SORT_KEYS.liveness`), and it ranks it by the very state this column
        // draws: a row sorted as broken under a circle drawn as working is the
        // one failure this control cannot have.
        sort: 'liveness',
        // The status cell reads as words, not as a figure: it is the one column
        // whose value is not a measurement and must not wear the readout face.
        base: 'text',
        labelKey: 'column.liveness',
        // The heading explains the circles rather than repeating the heading: the
        // five states are the one thing about this column a reader cannot infer
        // from the label next to it.
        hintKey: 'hint.liveness',
        cell: (row, ctx) => ctx.renderLiveness(row),
      },
      {
        key: 'steps',
        tier: 'core',
        base: 'num',
        sort: 'steps',
        labelKey: 'column.steps',
        hintKey: 'hint.steps',
        cell: (row, ctx) => ctx.fmt.count(row.steps),
      },
      {
        key: 'ttft',
        tier: 'core',
        base: 'num',
        sort: 'ttft',
        labelKey: 'column.ttft',
        hintKey: 'hint.ttft',
        // The figure and its bar are one inline box: the cell's own alignment
        // then covers both, and the bar hangs off the cell rather than off this
        // span, so it spans the whole column width.
        cell: (row, ctx) =>
          h(
            'span',
            { className: 'dsh-ms-val' },
            ctx.fmt.ms(row.ttftMedian),
            measurementScale(ctx, 'ttft', row.ttftMedian),
          ),
        tone: (row, ctx) => rankTone(ctx, 'ttft', row),
      },
      {
        key: 'tps',
        tier: 'core',
        base: 'num',
        // The column is called tok/s and the host calls the order `speed`; the
        // preset button says "скорость" and the heading says "tok/s med", and
        // both mean the median decode rate.
        sort: 'speed',
        labelKey: 'column.tps',
        hintKey: 'hint.tps',
        cell: (row, ctx) =>
          h(
            'span',
            { className: 'dsh-ms-val' },
            ctx.fmt.num(row.tpsMedian, 1),
            measurementScale(ctx, 'tps', row.tpsMedian),
          ),
        tone: (row, ctx) => rankTone(ctx, 'tps', row),
      },
      {
        key: 'errors',
        tier: 'core',
        sort: 'errors',
        labelKey: 'column.errors',
        hintKey: 'hint.errors',
        // The breakdown rides in the cell's own tooltip, not in a column of its
        // own: the total alone is not a decision, and one hover is where a
        // reader already goes to find out whether a number is a fact or a
        // symptom. The full list stays in the agent's text report.
        cell: (row, ctx) => {
          const figure = ctx.fmt.count(row.errors ?? 0)
          const detail = (row.errorCodes ?? []).slice(0, 6).map((e) => `${e.code}×${e.count}`)
          const blame = (row.errorCategories ?? [])
            .filter((e) => e.count > 0)
            .map((e) => `${e.category}×${e.count}`)
          const parts = []
          if (detail.length > 0) parts.push(detail.join(', '))
          if (blame.length > 0) parts.push(blame.join(', '))
          if (row.modelErrors !== undefined) {
            parts.push(`на долю модели: ${ctx.fmt.count(row.modelErrors)}`)
          }
          const text = parts.length === 0 ? null : parts.join(' · ')
          return h(
            'span',
            { className: 'dsh-ms-val', title: text, 'aria-label': text },
            figure,
          )
        },
        tone: (row) => (row.errors > 0 ? 'dsh-ms-bad' : null),
      },
      {
        key: 'errorRate',
        tier: 'extra',
        base: 'num',
        sort: 'errorRate',
        labelKey: 'column.errorRate',
        hintKey: 'hint.errorRate',
        // Through the shared formatter rather than `.toFixed` on the raw value:
        // a payload from a host that predates this column has no `errorRate` at
        // all, and `undefined.toFixed` takes the whole panel down.
        cell: (row, ctx) => ctx.fmt.num(row.errorRate, 1),
      },
      {
        key: 'modelErrors',
        tier: 'extra',
        base: 'num',
        sort: 'modelErrors',
        labelKey: 'column.modelErrors',
        hintKey: 'hint.modelErrors',
        cell: (row, ctx) => ctx.fmt.count(row.modelErrors ?? 0),
        tone: (row) => (row.modelErrors > 0 ? 'dsh-ms-bad' : null),
      },
      {
        key: 'interrupted',
        tier: 'extra',
        base: 'num',
        sort: 'interrupted',
        labelKey: 'column.interrupted',
        hintKey: 'hint.interrupted',
        cell: (row, ctx) => ctx.fmt.count(row.interrupted ?? 0),
        tone: (row) => (row.interrupted > 0 ? 'dsh-ms-warn' : null),
      },
      {
        key: 'ttftP90',
        tier: 'extra',
        sort: 'ttftP90',
        labelKey: 'column.ttftP90',
        hintKey: 'hint.ttftP90',
        cell: (row, ctx) => ctx.fmt.ms(row.ttftP90),
      },
      {
        key: 'tpsMax',
        tier: 'extra',
        sort: 'tpsMax',
        labelKey: 'column.tpsMax',
        hintKey: 'hint.tpsMax',
        cell: (row, ctx) => ctx.fmt.num(row.tpsMax, 1),
      },
      {
        key: 'confidence',
        tier: 'extra',
        sort: 'confidence',
        labelKey: 'column.confidence',
        hintKey: 'hint.confidence',
        cell: (row, ctx) =>
          row.speedConfidence === null
            ? dash
            : `${ctx.fmt.count(Math.round(row.speedConfidence * 100))}%`,
        tone: (row) => (row.speedConfidence !== null && row.speedConfidence < 0.5 ? 'dsh-ms-warn' : null),
      },
      {
        key: 'llm',
        tier: 'extra',
        sort: 'llm',
        labelKey: 'column.llm',
        hintKey: 'hint.llm',
        cell: (row, ctx) => ctx.fmt.ms(row.llmMeanMs),
      },
      {
        key: 'cache',
        tier: 'extra',
        sort: 'cache',
        labelKey: 'column.cache',
        hintKey: 'hint.cache',
        cell: (row, ctx) => ctx.fmt.pct(row.cacheHitRate),
      },
      // Retry rate. The companion `ttftClean` column is what makes this one
      // readable: a model that retries often but still answers quickly is a
      // flaky route, and a model that never retries and answers slowly is a
      // slow one. The rate alone cannot tell them apart.
      {
        key: 'retry',
        tier: 'extra',
        base: 'num',
        sort: 'retry',
        labelKey: 'column.retry',
        hintKey: 'hint.retry',
        cell: (row, ctx) => {
          if (row.retryRate === null || row.retryRate === undefined) return dash
          return h(
            'span',
            { className: 'dsh-ms-val' },
            ctx.fmt.pct(row.retryRate),
            measurementScale(ctx, 'retry', row.retryRate),
          )
        },
        // Amber once a fifth of the steps need a retry, red past a third: a
        // model that fails its way to an answer a fifth of the time is costing
        // the loop a fifth of its steps.
        tone: (row) =>
          row.retryRate === null || row.retryRate === undefined
            ? null
            : row.retryRate >= 0.33
              ? 'dsh-ms-bad'
              : row.retryRate >= 0.2
                ? 'dsh-ms-warn'
                : null,
      },
      {
        key: 'ttftClean',
        tier: 'extra',
        base: 'num',
        sort: 'ttftClean',
        labelKey: 'column.ttftClean',
        hintKey: 'hint.ttftClean',
        cell: (row, ctx) => ctx.fmt.ms(row.ttftCleanMedian),
      },
      // The useful decode rate, next to the streaming one. Both are the same
      // token count; the only difference is whether the wait for the first token
      // is in the denominator, and that difference is the ranking.
      {
        key: 'e2e',
        tier: 'extra',
        base: 'num',
        sort: 'e2e',
        labelKey: 'column.e2e',
        hintKey: 'hint.e2e',
        cell: (row, ctx) =>
          row.e2eTpsMedian === null || row.e2eTpsMedian === undefined
            ? dash
            : h(
                'span',
                { className: 'dsh-ms-val' },
                ctx.fmt.num(row.e2eTpsMedian, 1),
                measurementScale(ctx, 'e2e', row.e2eTpsMedian),
              ),
        tone: (row, ctx) => rankTone(ctx, 'e2e', row),
      },
      {
        key: 'prefill',
        tier: 'extra',
        base: 'num',
        sort: 'prefill',
        labelKey: 'column.prefill',
        hintKey: 'hint.prefill',
        cell: (row, ctx) => {
          if (row.prefillShareMedian === null || row.prefillShareMedian === undefined) return dash
          return h(
            'span',
            { className: 'dsh-ms-val' },
            ctx.fmt.pct(row.prefillShareMedian),
            measurementScale(ctx, 'prefill', row.prefillShareMedian),
          )
        },
      },
      // The only column whose fix is on this side: everything in it is time the
      // harness spent between the last delta and the closing message.
      {
        key: 'overhead',
        tier: 'extra',
        base: 'num',
        sort: 'overhead',
        labelKey: 'column.overhead',
        hintKey: 'hint.overhead',
        cell: (row, ctx) => ctx.fmt.ms(row.overheadMsMedian),
        tone: (row) => (row.overheadMsMedian !== null && row.overheadMsMedian >= 200 ? 'dsh-ms-warn' : null),
      },
      // The panel can sort by recency, so the timestamp it sorts by is a column
      // of its own instead of an invisible key.
      {
        key: 'lastSeen',
        tier: 'extra',
        sort: 'lastSeen',
        labelKey: 'column.lastSeen',
        hintKey: 'hint.lastSeen',
        cell: (row, ctx) => ctx.fmt.ago(row.lastSeen),
      },
    ]

    // Keep related measurements adjacent in both column sets. One header row
    // preserves the sticky corner and keyboard scroll clearance; subtle dividers
    // mark group boundaries without adding another sticky header to negotiate.
    const COLUMN_GROUPS = [
      ['name', 'liveness'],
      ['steps', 'lastSeen'],
      ['ttft', 'ttftP90', 'ttftClean', 'retry'],
      ['e2e', 'tps', 'tpsMax', 'confidence'],
      ['errorRate', 'modelErrors', 'errors', 'interrupted'],
      ['llm', 'prefill', 'overhead', 'cache'],
    ]
    const CORE_COLUMNS = new Set(['name', 'liveness', 'steps', 'ttft', 'e2e', 'errorRate'])
    const COLUMNS = COLUMN_GROUPS.flatMap((keys, group) => keys.map((key, index) => ({
      ...COLUMN_DEFINITIONS.find((column) => column.key === key),
      tier: CORE_COLUMNS.has(key) ? 'core' : 'extra',
      groupStart: group > 0 && index === 0,
    })))

    /**
     * The row holding the extreme value of one metric, or null when the metric
     * is unmeasured for every row.
     *
     * The best and the worst passes share it, so the two always rank the same
     * set of candidates. A tie keeps the first of the tied rows: a figure that
     * two rows share is not the property of whichever one happens to be
     * rendered first.
     */
    function extremeRow(rows, selector, better) {
      let winner = null
      for (const row of rows) {
        const value = selector(row)
        if (value === null || value === undefined || !Number.isFinite(value)) continue
        if (winner === null || better(value, selector(winner))) winner = row
      }
      return winner
    }

    /**
     * The tone of a ranked cell: green for the best value in the table, red for
     * the worst.
     *
     * One rule, one function — a table where the best and the worst were decided
     * by two different passes would sooner or later mark the same row both ways.
     * An unmeasured cell (`-`) is never a candidate for either, so a model the
     * provider recorded no timing for is not painted as the slowest one.
     */
    function rankTone(ctx, metric, row) {
      if (ctx.best[metric] === row) return 'dsh-ms-good'
      return ctx.worst[metric] === row ? 'dsh-ms-worst' : null
    }

    /**
     * The bar under one measurement: that value's share of the largest value of
     * its column among the rows on screen.
     *
     * This is the panel's signature, and it is information rather than ornament —
     * it turns a column of digits into a scale that can be read straight down the
     * page, and the tone the cell already wears colours the bar with it, so green
     * is the shortest bar on response and the longest on tok/s. A column of one
     * row draws no bar: there is nothing to compare it with. An unmeasured cell
     * draws none either, because `-` is not a small value.
     *
     * Hidden from assistive technology: the figure beside it is the same reading
     * in words, and a shape with no name of its own would only be noise.
     */
    function measurementScale(ctx, metric, value) {
      const scale = ctx.scale
      if (scale === undefined || scale.rows < 2) return null
      const max = scale[metric]
      if (!finite(value) || !(max > 0)) return null
      const share = Math.max(2, Math.min(100, Math.round((value / max) * 100)))
      return h(
        'span',
        { className: 'dsh-ms-scale', 'aria-hidden': 'true' },
        h('span', { className: 'dsh-ms-scale-fill', style: { width: `${share}%` } }),
      )
    }

    /** An ordinary cell is dimmed unless its column's tone claims it. */
    function cellClass(column, row, ctx) {
      const tone = typeof column.tone === 'function' ? column.tone(row, ctx) : null
      if (tone !== null) return tone
      // A column that reads as words — the status cell — keeps the panel's own
      // face instead of the readout one.
      if (column.base === 'text') return 'dsh-ms-text'
      return column.base === 'num' ? 'dsh-ms-num' : 'dsh-ms-dim'
    }

    /**
     * The liveness cell key for one row: `provider\u0000model`, and just
     * `provider\u0000` in the provider view, where the host sends a roll-up.
     * One key shape for both views is what lets a single reader serve both.
     */
    function livenessKey(row) {
      return `${row.provider}\u0000${row.model ?? ''}`
    }

    /**
     * The provider codes that mean "the row was refused", and what each family is
     * about.
     *
     * The same rule runs on the host (`lib/status.js`) and its verdict travels
     * with every probe result as `state`; this copy is what the panel keeps for
     * the *word* — "out of quota" against "throttled" is this panel's copy, and
     * the host ships a state, not a sentence — and for a result from a host that
     * predates that field. The duplication is the price of the panel being a
     * separate bundle that cannot import the host's module; it is not a second
     * source of truth, because the order the status heading asks for is decided
     * by the host's copy alone.
     *
     * `dsh-llm` publishes `code` as the machine-routable failure class and its own
     * docs say to route on it and never parse the message. That rule is about
     * routing — retry and backoff decide on a code that has to be stable — and the
     * codes are what decide the *state* here too. They are just not fine enough for
     * the word: the adapters spell an exhausted allowance and a momentary throttle
     * with the same `RATE_LIMIT`, because their classifier looks for quota wording
     * it recognises and quietly falls through to the status code for the rest. A
     * probe against a free tier answers `429` with "Daily free limit reached …
     * tokens used … resets at 00:00 UTC", `dsh-llm` calls that `RATE_LIMIT`, and a
     * panel that answered "слишком часто" was contradicting the operator with the
     * operator's own words in the very next line.
     *
     * A refused row is answering. "Too many requests", "no such model" and "the
     * check timed out" were all red before, so a reader seeing red switched models
     * — the one move that cannot help in any of the first three cases. What the
     * words name is whose move it is: the account (amber), the configuration (a
     * square), or the provider (solid red).
     */
    const RATE_LIMIT_CODES = new Set(['RATE_LIMIT', 'TOO_MANY_REQUESTS', 'HTTP_429'])
    const QUOTA_CODES = new Set(['QUOTA', 'ACCOUNT_QUOTA', 'INSUFFICIENT_QUOTA', 'HTTP_402'])
    const LIMIT_CODES = new Set([...RATE_LIMIT_CODES, ...QUOTA_CODES])
    // The provider answered and would not accept the credential: the fix is a key.
    const ACCESS_CODES = new Set([
      'AUTH', 'UNAUTHORIZED', 'FORBIDDEN', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL',
      'NO_KEY', 'HTTP_401', 'HTTP_403',
    ])
    // No route was ever wired: the fix is the provider's configuration.
    const ROUTE_CODES = new Set(['NO_ROUTE', 'NO_ADAPTER', 'NO_BASE_URL', 'UNSUPPORTED_API'])
    // The route is there and does not know this model: the fix is the model list.
    const MODEL_CODES = new Set(['UNKNOWN_MODEL', 'NOT_FOUND', 'MODEL_NOT_FOUND', 'HTTP_404'])
    // A request the provider rejected without saying why — which is also how a
    // `400`/`404` for a model that does not exist arrives from some providers, so
    // this one family reads the message before it settles for "unavailable".
    const VAGUE_CODES = new Set(['INVALID_REQUEST', 'HTTP_400'])
    const CONFIG_CODES = new Set([...ACCESS_CODES, ...ROUTE_CODES, ...MODEL_CODES])

    /**
     * The provider's own words, for the questions the code cannot answer: is this
     * refusal momentary or has the allowance run out, and is this rejected request
     * about a model that is simply not there?
     *
     * Read as evidence and never as an instruction, and only ever to choose between
     * words — a miss costs nothing but a coarser label, because every branch falls
     * back to the code. `dsh-llm` ships the same idea as `isQuotaExceededError`,
     * with its own list of wordings; these are supersets of the phrasings seen in
     * the wild, because a label that contradicts the message next to it is worse
     * than a coarse one.
     *
     * The message is truncated to 300 characters on the way into the store, and
     * every signal below sits near the front, where the code, type and message are.
     */
    // A promise of a retry in seconds, or a per-minute budget: momentary, whatever
    // else the message says.
    const SHORT_RETRY =
      /retry[\s_-]*after|try[\s_-]+again[\s_-]+(?:in|after)[\s_-]+\d+(?:[.,]\d+)?[\s_-]*(?:ms|s\b|sec|seconds|min|minutes|hour)|per[\s_-]+(?:min(?:ute)?s?\b|sec(?:ond)?s?\b|hour)/i
    // An allowance that is gone: `limit reached`, `quota exceeded`, `tokens used`,
    // `remaining: 0`, `insufficient balance`. A day or a month long, so it is the
    // one an impatient reader cannot wait out.
    const SPENT_ALLOWANCE =
      /insufficient[\s_-]+(?:quota|balance|credits?)|(?:quota|limit|allowance|budget)[\s_-]+(?:exceeded|exhausted|reached|used)|tokens?[\s_-]+used|remaining["'\s:=]*0|credits?[\s_-]+(?:exhausted|depleted|used)|out[\s_-]+of[\s_-]+(?:credits?|budget)/i
    // An account that has to be paid before it answers again, arriving as the same
    // `429` a momentary throttle does: "free models are for active keys … the last
    // top-up on this key was 2026-09-21, which is more than 7 days ago. Top it up
    // to use free models again". Waiting is not the fix the provider named, so it
    // belongs with the spent allowance rather than the throttle. A dormant or
    // expired key is here for the same reason — it is a fact about the account
    // that came back under a limit's code, and the code is what keeps the circle
    // amber; only the word is being chosen here.
    const TOP_UP =
      /\btop[\s_-]*(?:it[\s_-]*)?(?:up|ped)|recharge|(?:add|buy|purchase)[\s_-]+(?:credits?|funds?|balance)|(?:credit|balance)[\s_-]*(?:is[\s_-]+(?:too[\s_-]+low|empty|exhausted|expired)|too[\s_-]+low)|(?:expired|inactive|dormant)[\s_-]+(?:key|account|subscription)|key[\s_-]+(?:is[\s_-]+)?(?:expired|inactive|dormant)|for[\s_-]+active[\s_-]+keys?/i
    // The provider saying the model is not there at all: `model_not_found`, "does
    // not exist", "has no configured model", "is not available". Deliberately not
    // "temporarily unavailable", which is a provider having a bad day.
    const NO_SUCH_MODEL =
      /model[\s_-]+not[\s_-]+found|does[\s_-]+not[\s_-]+exist|no[\s_-]+such[\s_-]+model|has[\s_-]+no[\s_-]+configured[\s_-]+model|is[\s_-]+not[\s_-]+available|unknown[\s_-]+model/i

    /**
     * What a failed probe was refused for, as a state and the word for it, or
     * `null` when it failed for a reason that is not a refusal at all.
     *
     * The gate is that *every* code the row recorded belongs to the family: a
     * provider roll-up whose models failed for different reasons is down, not
     * misconfigured, and only a row that is entirely about one thing may wear that
     * thing's circle. Order matters twice over — amber needs the whole row to be a
     * limit, so a limit mixed with anything else is not painted as an account
     * problem; and when a configuration mixture happens anyway, the route outranks
     * the model, because a missing route makes the model question moot.
     *
     * The word is then: an explicit quota code, or failing that the provider's own
     * prose, with a top-up outranking a short retry and the short retry outranking
     * the rest — "try again in 1.2s" is a throttle even when the sentence also says
     * "limit reached", and "top it up" is neither, because no pause ends it.
     * Nothing said, and a bare `RATE_LIMIT` stays the throttle it is named after.
     */
    function refusalOf(probe) {
      const codes = Array.isArray(probe?.codes)
        ? probe.codes
        : typeof probe?.code === 'string'
          ? [probe.code]
          : []
      if (codes.length === 0) return null
      const named = codes.map((code) => String(code).toUpperCase())
      const every = (set) => named.every((code) => set.has(code))
      const some = (set) => named.some((code) => set.has(code))
      const words = typeof probe?.error === 'string' ? probe.error : ''

      if (every(LIMIT_CODES)) {
        if (some(QUOTA_CODES)) return { state: 'limited', labelKey: 'liveness.limited.quota' }
        if (TOP_UP.test(words)) return { state: 'limited', labelKey: 'liveness.limited.quota' }
        if (SHORT_RETRY.test(words)) return { state: 'limited', labelKey: 'liveness.limited.rate' }
        return {
          state: 'limited',
          labelKey: SPENT_ALLOWANCE.test(words) ? 'liveness.limited.quota' : 'liveness.limited.rate',
        }
      }
      if (every(VAGUE_CODES) && NO_SUCH_MODEL.test(words)) {
        return { state: 'missing', labelKey: 'liveness.missing.model' }
      }
      if (!every(CONFIG_CODES)) return null
      if (some(ROUTE_CODES)) return { state: 'missing', labelKey: 'liveness.missing.route' }
      if (some(MODEL_CODES)) return { state: 'missing', labelKey: 'liveness.missing.model' }
      return { state: 'denied', labelKey: 'liveness.denied' }
    }

    /**
     * The status itself, in lower case, for a failure that no word covers.
     *
     * “Unavailable” says the one thing every red circle has in common — nobody
     * answered — and for a timeout, a 500 and a dropped socket that is the code
     * restated in Russian, while the fact that tells those three apart waits one
     * hover away. So a cell that cannot name the failure prints what it is: the
     * host's own machine-routable status, as it arrived, in lower case and without
     * the shouting — `timeout`, `server`, `http_500`, `transport`. An id, not a
     * sentence, because the panel does not own this vocabulary and inventing
     * Russian for it would be a guess next to the real one.
     *
     * A roll-up has no code of its own and names the codes it counted, deduped and
     * joined, which is the same list its tooltip prints. With no code at all there
     * is nothing to print, and the word stands.
     */
    function rawStatusWord(probe) {
      const codes = Array.isArray(probe?.codes)
        ? probe.codes
        : typeof probe?.code === 'string'
          ? [probe.code]
          : []
      const words = [
        ...new Set(
          codes
            .map((code) => String(code).trim().toLowerCase())
            .filter((code) => code !== ''),
        ),
      ]
      return words.length > 0 ? words.join(' · ') : null
    }

    /**
     * What the status cell shows for one row.
     *
     * Three facts decide it, and the order between them is the whole rule:
     *
     *   1. **A probe running right now** outranks a past result. While a model is
     *      being checked the circle is neither green nor red, because the answer
     *      is not in yet and a stale one drawn as current is worse than none.
     *   2. **The last probe's own answer**: green, amber for a refusal on a limit,
     *      red for everything else.
     *   3. **History later than the probe.** A failed probe is a fact about a
     *      moment, and a model that answered *after* that moment is not down —
     *      the check is older than the evidence. So a failure whose `lastSeen` is
     *      later than its `checkedAt` reads as available, and says so. That covers
     *      a limit as much as a timeout: a model that answered after a 429 is
     *      throttled no longer.
     *
     * That third case is deliberately its own badge rather than a silent "yes":
     * a reader choosing what to run needs to know the model was not proved live
     * just now, it was proved live at some other time.
     */
    function livenessView(row, overrides, checking, t, fmt) {
      const key = livenessKey(row)
      // A probe this browser has seen outranks the one the table's own answer
      // carried, because the table answer may predate the check by minutes.
      const probe = overrides[key] ?? row.liveness ?? null
      const inFlight = checking.has(key) === true || row.livenessChecking === true

      const checkedAt = finite(probe?.checkedAt) ? probe.checkedAt : null
      const lastSeen = finite(row.lastSeen) ? row.lastSeen : null
      const probed = typeof probe?.status === 'string'
      // Read for the word, not for the state: which limit, whose fault. The
      // state itself is the host's, shipped with the result.
      const refusal = probed && probe.status !== 'ok' ? refusalOf(probe) : null
      // The host classifies a failure once and ships the state with the result,
      // so this circle and the row order the status heading asks for are two
      // readings of one rule. The classification below is the fallback for a
      // result that carries no state — an override absorbed from a host that
      // predates the field — and that is the only place it can be needed: such a
      // host does not know `sort=liveness` either, so there is no order for the
      // two verdicts to disagree about. It stays because a *word* still has to
      // come from somewhere, and the wording is this panel's own.
      const hostState = typeof probe?.state === 'string' ? probe.state : null
      const base =
        hostState ?? (probed ? (probe.status === 'ok' ? 'up' : refusal === null ? 'down' : refusal.state) : 'unknown')
      // The user-facing rule, and the reason this cell is not a plain mirror of
      // the probe result.
      const seenAfterCheck =
        base !== 'up' && base !== 'unknown' && checkedAt !== null && lastSeen !== null && lastSeen > checkedAt
      const state = inFlight ? 'checking' : seenAfterCheck ? 'up' : base
      // Each refusal gets its own word — which limit, whose fault — and keeps it
      // only while the circle still shows that refusal: a failure that history has
      // overtaken is "available", not "out of quota".
      const labelKey = refusal !== null && state === refusal.state ? refusal.labelKey : `liveness.${state}`
      // A failure no family claims has no word, and this is the one state where
      // that is worth saying out loud: the circle is red because nothing classified
      // it, so the cell names the status instead of saying "unavailable" for the
      // hundredth time. Only there — a green circle and a claim about a key, a
      // route or a model all keep the word they are decided by.
      const labelRaw = state === 'down' ? rawStatusWord(probe) : null

      const facts = []
      if (lastSeen !== null) facts.push(t('liveness.lastRequest', { ago: fmt.ago(lastSeen) }))
      if (checkedAt !== null) {
        const latency = finite(probe?.latencyMs) ? ` ${fmt.ms(probe.latencyMs)}` : ''
        facts.push(`${t('liveness.checked', { ago: fmt.ago(checkedAt) })}${latency}`)
      }
      // A provider roll-up answers for a set, so the count is what makes it a
      // fact rather than an impression.
      if (probe?.rolledUp === true && probe.counts) {
        facts.push(t('liveness.summary', { checked: fmt.count(probe.counts.ok), total: fmt.count(probe.counts.total) }))
      }
      if (seenAfterCheck) facts.push(t('liveness.byHistory'))

      // The failure's own words are the evidence under the claim, whatever the
      // claim is: a limit's code and message explain an amber circle as much as a
      // timeout explains a red one.
      const failure =
        !inFlight && base !== 'up' && base !== 'unknown' && typeof probe?.error === 'string'
          ? probe.error
          : null
      // A roll-up has no code of its own: the codes of the failures it counted are
      // what it can name.
      const named =
        typeof probe?.code === 'string'
          ? probe.code
          : Array.isArray(probe?.codes) && probe.codes.length > 0
            ? probe.codes.join(' · ')
            : null
      const detail = [named, failure].filter((part) => typeof part === 'string' && part !== '').join(' — ')

      return { state, key, checkedAt, lastSeen, detail, facts, probe, inFlight, seenAfterCheck, refusal, labelKey, labelRaw }
    }

    /**
     * One line naming where the numbers came from and how fresh they are.
     *
     * The panel answers from a cached fold first, so it must also say when that
     * fold is stale and how much of it is still being refreshed. `filtered` is
     * what a provider filter left of the history, which the totals beside it
     * cannot say: those are the whole history, by design.
     */
    function footerSummary(data, totals, pending, t, fmt, filtered) {
      const parts = [t('footer.scanned', { count: fmt.count(data.scanned) })]
      if (data.skipped) parts.push(t('footer.skipped', { count: fmt.count(data.skipped) }))
      if (totals) {
        parts.push(
          t('footer.steps', { count: fmt.count(totals.steps) }),
          t('footer.models', { count: fmt.count(totals.models) }),
        )
      }
      if (filtered) {
        parts.push(
          t(filtered.view === 'provider' ? 'footer.shown.providers' : 'footer.shown.models', {
            count: fmt.count(filtered.models),
            steps: fmt.count(filtered.steps),
          }),
        )
      }
      // The archive is the one filter that can be on without naming anything the
      // reader typed, so the footer says how many rows it is holding back. A
      // footer that counted only what is on screen would leave that number
      // invisible, and the totals beside it are the whole history by design.
      if (data.archive && data.archive.rows > 0 && data.archive.shown !== true) {
        parts.push(t('footer.archive', { count: fmt.count(data.archive.rows) }))
      }
      // How many rows of this table come from the configuration alone. A table
      // of dashes needs the number said out loud: without it the reader cannot
      // tell "these models were never used" from "these numbers failed to load",
      // and the count is over the filtered set rather than the page, exactly like
      // the archive's — a host that answered `noStats: null` (it could not read
      // the configuration) says nothing here rather than saying zero.
      const noStats = data.noStats === null || data.noStats === undefined ? 0 : (data.noStats.rows ?? 0)
      if (noStats > 0) parts.push(t('footer.noStats', { count: fmt.count(noStats) }))
      if (data.readNow > 0) parts.push(t('footer.readNow', { count: fmt.count(data.readNow) }))
      if (data.reused > 0) parts.push(t('footer.reused', { count: fmt.count(data.reused) }))
      if (pending > 0) parts.push(t('footer.pending', { count: fmt.count(pending) }))
      if (Number.isFinite(data.snapshotAt)) {
        parts.push(t('footer.snapshot', { ago: fmt.ago(data.snapshotAt) }))
      }
      return parts.join(' · ')
    }

    // --- styles ------------------------------------------------------------------
    // Containers and controls inherit host theme tokens; nothing hard-codes a color.
    const css = `
/* The panel dresses as a bench instrument: a quiet frame, hairline rules, and
   every measurement in the readout face. It owns no colour of its own — the
   tokens are the host's, cached once on the root so the rules below stay short. */
.dsh-ms-root { --ms-line:var(--dsw-alias-border-l1); --ms-line-2:var(--dsw-alias-border-l2);
  --ms-ink:var(--dsw-alias-label-primary); --ms-ink-2:var(--dsw-alias-label-secondary);
  --ms-ink-3:var(--dsw-alias-label-tertiary);
  --ms-fill:var(--dsw-alias-bg-layer-2); --ms-sunken:var(--dsw-alias-bg-layer-1);
  --ms-hover:var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
  --ms-accent:var(--dsw-alias-brand-primary);
  --ms-ring:var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  --ms-ring-w:var(--dsw-focus-ring-width, 2px);
  --ms-readout:var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  display:flex; flex-direction:column; gap:10px; padding:4px 0 18px;
  /* The browser's default tap highlight is a grey box that has nothing to do with
     this panel's own hover and active states; the controls draw their own. */
  -webkit-tap-highlight-color:transparent; }
.dsh-ms-head { display:flex; flex-wrap:wrap; align-items:baseline; gap:3px 16px;
  padding-bottom:9px; border-bottom:.5px solid var(--ms-line); }
.dsh-ms-title { margin:0; font-size:15px; line-height:1.35; font-weight:600; color:var(--ms-ink);
  text-wrap:balance; }
.dsh-ms-meta { font-size:12px; line-height:1.45; color:var(--ms-ink-2); max-width:74ch;
  text-wrap:pretty; }
/* The panel's one movement: a sweep along a two-pixel rule while a request is in
   flight. It is mounted whether or not it runs, so nothing shifts when work
   starts. */
.dsh-ms-sweep { position:relative; height:2px; margin-top:-4px; border-radius:1px; overflow:hidden;
  background:var(--ms-line); opacity:0; transition:opacity .18s linear; }
.dsh-ms-sweep[data-busy="true"] { opacity:1; }
.dsh-ms-sweep-fill { position:absolute; top:0; bottom:0; left:0; width:34%; border-radius:1px;
  background:var(--ms-accent); animation:dsh-ms-sweep 1.2s ease-in-out infinite; }
@keyframes dsh-ms-sweep { from { transform:translateX(-100%); } to { transform:translateX(294%); } }
.dsh-ms-bar { display:flex; flex-wrap:wrap; align-items:center; gap:6px 8px; }
.dsh-ms-group { display:inline-flex; align-items:center; gap:6px; min-width:0; }
.dsh-ms-group-label { font-size:10.5px; letter-spacing:.04em; color:var(--ms-ink-3);
  user-select:none; }
.dsh-ms-chip { font:inherit; font-size:12px; line-height:1.35; padding:3px 9px;
  border-radius:var(--dsw-radius-sm, 6px); cursor:pointer; touch-action:manipulation;
  border:1px solid var(--ms-line); background:var(--ms-fill); color:var(--ms-ink-2);
  transition:background-color .12s ease, border-color .12s ease, color .12s ease; }
.dsh-ms-chip:hover { border-color:var(--ms-line-2); color:var(--ms-ink); }
.dsh-ms-chip:active { background:var(--dsw-alias-interactive-bg-active, var(--ms-sunken)); }
.dsh-ms-chip[aria-pressed="true"] { border-color:var(--ms-accent); color:var(--ms-accent); }
.dsh-ms-btn { display:inline-flex; align-items:center; justify-content:center; gap:6px;
  min-width:118px; font:inherit; font-size:12px; padding:4px 11px;
  border-radius:var(--dsw-radius-sm, 6px); cursor:pointer; touch-action:manipulation;
  border:1px solid var(--ms-line); background:var(--ms-fill); color:var(--ms-ink);
  transition:background-color .12s ease, border-color .12s ease; }
.dsh-ms-btn:hover { border-color:var(--ms-line-2); }
.dsh-ms-btn:active { background:var(--dsw-alias-interactive-bg-active, var(--ms-sunken)); }
/* Not the disabled attribute: a control that is busy keeps focus and its tab
   stop, and the reader who pressed it keeps their place. */
.dsh-ms-btn[aria-disabled="true"], .dsh-ms-chip[aria-disabled="true"] { opacity:.6; cursor:default; }
.dsh-ms-btn[aria-disabled="true"]:hover, .dsh-ms-chip[aria-disabled="true"]:hover {
  border-color:var(--ms-line); }
/* Feedback for a request in flight. Under reduced motion it keeps turning, just
   slowly: a frozen ring reads as a stuck panel, and this is the only signal
   that the panel is doing something. */
.dsh-ms-spin { width:10px; height:10px; border-radius:50%; border:2px solid var(--ms-line-2);
  border-top-color:var(--ms-accent); animation:dsh-ms-turn .7s linear infinite; }
@keyframes dsh-ms-turn { to { transform:rotate(360deg); } }
/* One ring for every control, drawn on the host's own focus tokens rather than
   on a colour of this panel's invention. An outline rather than a shadow: the
   table wrapper clips whatever overflows it. */
.dsh-ms-chip:focus-visible, .dsh-ms-btn:focus-visible, .dsh-ms-sort:focus-visible,
.dsh-ms-live-button:focus-visible, .dsh-ms-filter > summary:focus-visible,
.dsh-ms-legend-toggle:focus-visible { outline:var(--ms-ring-w) solid var(--ms-ring);
  outline-offset:2px; }
/* The provider filter is a disclosure, not a popover: it opens in place and
   pushes the table down. An absolutely positioned panel would need its own layer
   for no gain, and the list is a plain set of checkboxes — nothing here needs
   one. */
.dsh-ms-filter { position:relative; }
.dsh-ms-filter > summary { list-style:none; display:inline-flex; align-items:center; gap:6px; }
.dsh-ms-filter > summary::-webkit-details-marker { display:none; }
/* The disclosure caret is drawn, not written: a glyph in the markup would be
   read out as part of the control's own name. */
.dsh-ms-filter > summary::after { content:"";
  width:5px; height:5px; margin-top:-3px; flex:none; border-right:1.5px solid currentColor;
  border-bottom:1.5px solid currentColor; transform:rotate(45deg);
  transition:transform .12s ease; }
.dsh-ms-filter[open] > summary::after { transform:rotate(-135deg); margin-top:2px; }
.dsh-ms-filter[open] > summary { border-color:var(--ms-accent); color:var(--ms-accent); }
.dsh-ms-filter-panel { display:flex; flex-direction:column; gap:6px; margin:8px 0 2px; padding:8px;
  border:1px solid var(--ms-line); border-radius:var(--dsw-radius-md, 8px);
  background:var(--ms-fill); max-width:420px; }
.dsh-ms-filter-list { display:flex; flex-direction:column; gap:2px; max-height:220px; overflow:auto;
  overscroll-behavior:contain; }
.dsh-ms-filter-row { display:flex; align-items:center; gap:8px; padding:4px 6px;
  border-radius:var(--dsw-radius-xs, 4px); font-size:12px; color:var(--ms-ink); cursor:pointer;
  touch-action:manipulation; }
.dsh-ms-filter-row:hover { background:var(--ms-hover); }
.dsh-ms-filter-row:focus-within { outline:var(--ms-ring-w) solid var(--ms-ring); outline-offset:-2px; }
.dsh-ms-filter-row input { margin:0; flex:none; accent-color:var(--ms-accent); }
/* A provider the cap keeps out of the selection says so by looking out of it. */
.dsh-ms-filter-row input:disabled + .dsh-ms-filter-name { color:var(--ms-ink-3); }
.dsh-ms-filter-name { flex:1 1 auto; min-width:0; overflow-wrap:anywhere; }
.dsh-ms-filter-count { flex:none; font-size:11px; color:var(--ms-ink-3);
  font-variant-numeric:tabular-nums; }
.dsh-ms-filter-note { font-size:11.5px; line-height:1.45; color:var(--ms-ink-3); text-wrap:pretty; }
/* The archive is not one of the providers and does not sit in their list: a rule
   and a wider gap keep it above them as the second dimension it is. */
.dsh-ms-filter-archive { border-bottom:.5px solid var(--ms-line); border-radius:0;
  margin-bottom:4px; padding-bottom:6px; }
/* Visually hidden, still read: a shortened model id must not lose the full one. */
.dsh-ms-sr-only { position:absolute; width:1px; height:1px; margin:-1px; padding:0; border:0;
  overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
/* A bounded scroller, not a growing table: with ~50 rows the panel used to push
   the footer and the legend far below the fold, and the sticky header below had
   no scroller to stick to (overflow-x alone never scrolls vertically). The cap
   is in viewport units so a short window still gets a usable table, and the
   padding above the first row leaves the pinned header somewhere to stand. */
.dsh-ms-wrap { overflow:auto; max-height:min(64vh, 640px); overscroll-behavior:contain;
  scroll-padding-top:34px; border:1px solid var(--ms-line);
  border-radius:var(--dsw-radius-md, 8px); background:var(--ms-sunken); }
.dsh-ms-table { border-collapse:collapse; width:100%; font-size:12px; font-variant-numeric:tabular-nums; }
.dsh-ms-table th, .dsh-ms-table td { position:relative; padding:7px 8px; text-align:right;
  white-space:nowrap; border-bottom:.5px solid var(--ms-line); }
.dsh-ms-table .dsh-ms-left { text-align:left; }
.dsh-ms-table .dsh-ms-group-start, .dsh-ms-table [data-group-start] { border-left:1px solid var(--ms-line); padding-left:14px; }
/* In an auto-layout table the browser may shrink the name column to its
   min-content — a single breakable character — once the expanded column set
   competes for width, which turns a model path into a vertical ribbon. Give
   the column a readable floor and let the wrapper scroll instead. */
.dsh-ms-table th.dsh-ms-left, .dsh-ms-table td.dsh-ms-model { min-width:172px; }
/* The name column is pinned to the left edge. Ten 'nowrap' columns do not fit
   the page, so the table scrolls sideways — and without a pin the row's own
   identity is the first thing to leave the screen, which leaves a table of
   numbers that no longer says whose numbers they are.
   ':first-child' is the name column because COLUMNS puts it first and the
   column-set filter never drops it — a 'dsh-ms-left' hook would not do, because
   the status column is left-aligned too, and it is not the first.
   The cell wears the wrapper's own background so the columns sliding behind it
   are covered rather than read through: an opaque cell is what makes a pin a
   pin. Both rules it needs — the vertical edge against the column sliding past,
   and the hairline under the row — are shadows and not borders, for the reason
   spelled out under the pinned header below: a collapsed border belongs to the
   table's border grid. Measured in Chromium, that grid keeps the border where
   the column *was*, so under the stuck cell the rows came out unbounded while
   the rest of the table kept its rules.
   The z-index ladder is the whole trick of stacking the two sticky axes: a
   scrolling cell (auto) passes under the pinned column (2), the pinned column
   under the header row (3), and the header row under the pinned corner (4), so
   neither axis ever draws over the cell that must stay whole.
   The keyboard needs nothing of its own here, unlike the header's
   'scroll-padding-top': measured in Chromium, focusing a cell scrolled out of
   sight scrolls it clear of the sticky column rather than under it. */
.dsh-ms-table tbody td:first-child { position:sticky; left:0; z-index:2;
  background:var(--ms-sunken);
  box-shadow:inset -1px 0 0 var(--ms-line), inset 0 -1px 0 var(--ms-line); }
/* The last row carries no rule under it, and the pin draws one of its own — so
   the shadow has to be told about the row the border rule already knows. */
.dsh-ms-table tbody tr:last-child td:first-child {
  box-shadow:inset -1px 0 0 var(--ms-line); }
/* The rule under the pinned header has to travel with it: the cells' own
   border-bottom scrolls away with the rows, leaving text to slide under a
   header with no edge of its own. */
.dsh-ms-table thead th { position:sticky; top:0; z-index:3; background:var(--ms-fill);
  color:var(--ms-ink-3); font-size:11px; font-weight:600; letter-spacing:.02em;
  box-shadow:inset 0 -1px 0 var(--ms-line-2); }
/* The pinned corner carries both of the rules the two axes would otherwise lose
   with their borders, and sits above both. */
.dsh-ms-table thead th:first-child { left:0; z-index:4; background:var(--ms-fill);
  box-shadow:inset -1px 0 0 var(--ms-line), inset 0 -1px 0 var(--ms-line-2); }
.dsh-ms-table tbody tr:last-child td { border-bottom:none; }
.dsh-ms-table tbody tr:hover td { background:var(--ms-hover); }
/* The hover tint is laid over the pin's own background rather than replacing it:
   the row rule is a 'background' shorthand that resets the colour the pin
   stands on, and the host's hover token is translucent (6% in the light theme),
   so a pin that let the shorthand win is a pin the columns behind it read
   through. */
.dsh-ms-table tbody tr:hover td:first-child {
  background-color:var(--ms-sunken);
  background-image:linear-gradient(var(--ms-hover), var(--ms-hover)); }
/* A measurement is read, not skimmed: the readout face and tabular figures line
   the digits up column by column, which is what makes a vertical scan possible.
   The status cell is the table's one column of words and keeps the panel's own
   face — the only cell where a figure is not the value. */
.dsh-ms-table td.dsh-ms-num, .dsh-ms-table td.dsh-ms-dim, .dsh-ms-table td.dsh-ms-good,
.dsh-ms-table td.dsh-ms-worst, .dsh-ms-table td.dsh-ms-warn, .dsh-ms-table td.dsh-ms-bad {
  font-family:var(--ms-readout); font-size:11.5px; letter-spacing:.01em; }
/* The status cell is the table's one column of words: it keeps the panel's own
   face, where every other cell is a measurement. */
.dsh-ms-table td.dsh-ms-text { font-family:inherit; }
/* The signature. Under the two headline metrics every figure carries its share of
   the largest value in its column, so the column reads as a strip chart rather
   than as digits. The tone the cell already wears colours the bar with it, so on
   response the green bar is the shortest and on tok/s it is the longest. */
/* It rides on the row's own hairline rather than floating above it: two parallel
   rules under one number read as a decoration, one reads as a scale. The fill is
   anchored at the right edge, under the digits it measures. */
.dsh-ms-scale { position:absolute; left:10px; right:10px; bottom:0; height:2px; border-radius:1px;
  overflow:hidden; background:color-mix(in srgb, currentColor 22%, transparent); }
.dsh-ms-scale-fill { display:block; height:100%; margin-left:auto; border-radius:1px;
  background:color-mix(in srgb, currentColor 70%, transparent); }
/* The width cap lives on an inner block, not on the td: in an auto-layout table
   browsers ignore max-width on table cells, so a long unbreakable model path
   used to widen the column and spill past the cell border.
   The model cell is addressed as td.dsh-ms-model because the generic
   .dsh-ms-table td rule (specificity 0,1,1) otherwise beats a bare
   .dsh-ms-model (0,1,0) and keeps white-space:nowrap — which is what stopped
   the path from wrapping in the first place. */
.dsh-ms-table td.dsh-ms-model { text-align:left; white-space:normal; }
.dsh-ms-model-inner { max-width:270px; white-space:normal; overflow-wrap:anywhere;
  word-break:break-word; }
.dsh-ms-model-name { display:block; font-size:12px; line-height:1.4; font-weight:500;
  color:var(--ms-ink); }
.dsh-ms-provider { display:block; font-size:11px; line-height:1.35; font-weight:400;
  color:var(--ms-ink-2); overflow-wrap:anywhere; }
/* A row the configuration no longer serves. It is not an error — nothing about
   the measurements is wrong — so it wears the tertiary ink and a hairline rather
   than a state colour, which in this panel means a verdict. */
.dsh-ms-archive { display:inline-block; margin-top:2px; padding:0 5px;
  border:1px solid var(--ms-line); border-radius:var(--dsw-radius-xs, 4px);
  font-size:10px; line-height:1.5; letter-spacing:.02em; color:var(--ms-ink-3); }
/* A row the configuration serves and no session has ever run. It is the same
   kind of statement as the archive mark — a fact about the configuration, not a
   verdict about the model — so it wears the same shape and the same tertiary
   ink; the two never appear on one row, because a row is either known to the
   configuration or not. */
.dsh-ms-nostats { display:inline-block; margin-top:2px; margin-right:4px; padding:0 5px;
  border:1px solid var(--ms-line); border-radius:var(--dsw-radius-xs, 4px);
  font-size:10px; line-height:1.5; letter-spacing:.02em; color:var(--ms-ink-3); }
.dsh-ms-num { color:var(--ms-ink); }
.dsh-ms-dim { color:var(--ms-ink-2); }
.dsh-ms-warn { color:var(--dsw-alias-state-warn-primary); }
/* The other end of the same ranking. Red is already the panel's "bad" — a
   request that ended in an error — so the worst median wears that same token
   rather than a second red that a reader would have to tell apart from it. */
.dsh-ms-bad, .dsh-ms-worst { color:var(--dsw-alias-state-error-primary); }
.dsh-ms-good { color:var(--dsw-alias-state-success-primary); }
/* The status cell is one claim plus, when the column set has room for it, its
   evidence. The two are stacked rather than laid out side by side because the
   evidence is what a reader checks when the claim surprises them, and a row of
   numbers next to a word is read as more numbers. In the short column set the
   evidence is not drawn at all: it stays in the button's tooltip, which carries
   the same sentence the screen reader gets. */
.dsh-ms-live { display:flex; flex-direction:column; align-items:flex-start; gap:2px;
  /* Capped, so the two-line cell cannot set the width of the whole table: the
     claim and its evidence wrap instead of pushing the metrics off the page. */
  max-width:190px; text-align:left; white-space:normal; }
.dsh-ms-live-button { display:inline-flex; align-items:center; gap:6px; padding:0; border:0;
  background:none; color:var(--ms-ink); font:inherit; font-size:12px; cursor:pointer;
  text-align:left; touch-action:manipulation; border-radius:var(--dsw-radius-xs, 4px); }
.dsh-ms-live-button:hover .dsh-ms-live-label { text-decoration:underline; text-underline-offset:2px; }
.dsh-ms-live-button:active .dsh-ms-live-label { opacity:.7; }
.dsh-ms-live-button[aria-disabled="true"] { cursor:progress; }
.dsh-ms-live-dot { width:8px; height:8px; flex:none; border-radius:50%; background:var(--ms-ink-3); }
/* The dot carries the state; the label repeats it in words for the reader who
   cannot rely on the colour alone — and the words are the same ones the tooltip
   and the screen reader get.
   One colour, one meaning. Amber is a provider's refusal on a limit and nothing
   else, so a check in flight borrows the panel's own accent — the colour of the
   sweep under the heading and the ring in the footer, which is what "the panel
   is working" already looks like here. The pulse repeats that fact rather than
   carrying it: with reduced motion it stops and the colour still says it.
   Red covers three words, so it is split by shape rather than by a hue: a circle
   is a check with nobody to answer it, a square is a row that is not configured —
   "нет доступа", "нет маршрута", "нет модели". Shape, because at eight pixels a
   fill alone is just a paler dot; a square and not a ring, because corners are
   what survive being drawn this small. A triangle loses half its box to empty
   space and is the universal warning sign, in the one column where amber already
   means a warning.
   The square is filled, which is the loudest mark in the column — more ink than
   the filled circle that means "the provider did not answer". That is the point
   of it: a row that cannot be run at all, and cannot be made to run by waiting,
   is louder news than a route that may answer again. The cost is real and the
   column can afford it, because these two words are also the rarest — a provider
   comes back, a key and a route stay wrong until someone edits a file. An outlined
   square is one line away if the hierarchy ever matters more than the alarm: drop
   the background and keep an inset 1.5px ring in --dsw-alias-state-error-primary.
   A reader who cannot tell the shapes apart still gets the word. */
.dsh-ms-live-dot[data-state="up"] { background:var(--dsw-alias-state-success-primary); }
.dsh-ms-live-dot[data-state="limited"] { background:var(--dsw-alias-state-warn-primary); }
.dsh-ms-live-dot[data-state="down"] { background:var(--dsw-alias-state-error-primary); }
.dsh-ms-live-dot[data-state="denied"], .dsh-ms-live-dot[data-state="missing"] {
  background:var(--dsw-alias-state-error-primary); border-radius:1.5px; }
.dsh-ms-live-dot[data-state="checking"] { background:var(--ms-accent);
  animation:dsh-ms-pulse 1.1s ease-in-out infinite; }
.dsh-ms-live-label[data-state="up"] { color:var(--dsw-alias-state-success-primary); }
.dsh-ms-live-label[data-state="limited"] { color:var(--dsw-alias-state-warn-primary); }
.dsh-ms-live-label[data-state="down"], .dsh-ms-live-label[data-state="denied"],
.dsh-ms-live-label[data-state="missing"] { color:var(--dsw-alias-state-error-primary); }
.dsh-ms-live-label[data-state="checking"] { color:var(--ms-accent); }
.dsh-ms-live-label[data-state="unknown"] { color:var(--ms-ink-2); }
/* The evidence line is the smallest type in the panel, but it is read, not
   guessed at: one step up from the caption size and not a pixel lower. */
.dsh-ms-live-meta { display:block; color:var(--ms-ink-2); font-size:10.5px; line-height:1.4;
  font-variant-numeric:tabular-nums; }
@keyframes dsh-ms-pulse { 50% { opacity:.4; } }
/* A heading that explains itself says so before it is hovered. A table heading
   cannot take focus, so the dotted underline is the whole affordance a
   keyboard user gets — it has to be visible, not just the cursor. */
.dsh-ms-table th[title] { cursor:help; text-decoration:underline dotted; text-underline-offset:3px; }
/* A heading that sorts is a button wearing the heading's clothes: it inherits
   the header's type, colour and weight, and takes the block's own focus ring so
   the table has one focus style rather than two. */
.dsh-ms-sort { display:inline-flex; align-items:center; gap:4px; margin:-3px -5px; padding:3px 5px;
  font:inherit; color:inherit; background:none; border:none;
  border-radius:var(--dsw-radius-xs, 4px); cursor:pointer; touch-action:manipulation; }
.dsh-ms-sort:hover { color:var(--ms-ink); background:var(--ms-sunken); }
.dsh-ms-sort:active { background:var(--dsw-alias-interactive-bg-active, var(--ms-fill)); }
/* The arrow sits in every heading and is only drawn in the one that is the
   order. Its box keeps the headings on one baseline: an empty span in some and a
   glyph in another would shift the row as the order changes. */
.dsh-ms-arrow { width:1em; font-size:9px; line-height:1; color:var(--ms-accent); text-align:center; }
/* The legend is a footnote and it starts folded: the table answers its question
   first, and six lines of prose under a full table were the panel's loudest
   quiet part. Its summary is the last one in the tree — the filter's disclosure
   stays the first. */
.dsh-ms-legend { border-top:.5px solid var(--ms-line); padding-top:9px; }
.dsh-ms-legend-toggle { display:inline-flex; align-items:center; gap:6px; font:inherit;
  font-size:11.5px; margin-left:-5px; padding:2px 5px; border:0;
  border-radius:var(--dsw-radius-xs, 4px); background:none; color:var(--ms-ink-3);
  cursor:pointer; touch-action:manipulation; transition:background-color .12s ease, color .12s ease; }
.dsh-ms-legend-toggle:hover { color:var(--ms-ink-2); background:var(--ms-sunken); }
.dsh-ms-legend-toggle[aria-expanded="true"] { color:var(--ms-ink-2); }
.dsh-ms-legend-toggle::after { content:""; width:5px; height:5px; margin-top:-3px; flex:none;
  border-right:1.5px solid currentColor; border-bottom:1.5px solid currentColor;
  transform:rotate(45deg); transition:transform .12s ease; }
.dsh-ms-legend-toggle[aria-expanded="true"]::after { transform:rotate(-135deg); margin-top:2px; }
.dsh-ms-note { margin-top:8px; font-size:11.5px; line-height:1.55; color:var(--ms-ink-2);
  max-width:78ch; text-wrap:pretty; }
/* A state without rows reads as a note pinned to the bench — a dashed frame, so
   it cannot be mistaken for a table that simply came out empty. */
.dsh-ms-empty { padding:16px; font-size:12.5px; line-height:1.55; color:var(--ms-ink-2);
  border:1px dashed var(--ms-line); border-radius:var(--dsw-radius-md, 8px);
  background:var(--ms-sunken); max-width:78ch; text-wrap:pretty; }
.dsh-ms-alert { padding:8px 10px; border-radius:var(--dsw-radius-sm, 6px);
  border:1px solid var(--ms-line); border-left:3px solid var(--dsw-alias-state-warn-primary);
  background:var(--ms-fill); font-size:12px; line-height:1.5; color:var(--ms-ink);
  overflow-wrap:anywhere; max-width:78ch; }
/* The same line, without the alarm: a request still in flight is not a failure,
   and colouring it like one would teach the user to ignore the warn border. */
.dsh-ms-alert.dsh-ms-quiet { border-left-color:var(--ms-line-2); color:var(--ms-ink-2); }
/* A failure is not a warning and does not wear the warning's stripe. */
.dsh-ms-alert.dsh-ms-failed { border-left-color:var(--dsw-alias-state-error-primary); }
.dsh-ms-foot { display:flex; flex-wrap:wrap; align-items:center; gap:10px; }
@media (prefers-reduced-motion: reduce) {
  .dsh-ms-chip, .dsh-ms-btn, .dsh-ms-sweep, .dsh-ms-legend-toggle,
  .dsh-ms-filter > summary::after, .dsh-ms-legend-toggle::after { transition:none; }
  /* The sweep stops travelling and simply stands: a still rule still says the
     panel is waiting, and travelling is the whole of what the setting spares. */
  .dsh-ms-sweep-fill { animation:none; width:100%; opacity:.45; }
  .dsh-ms-live-dot[data-state="checking"] { animation:none; }
  /* The ring keeps turning, slowly: a frozen ring reads as a stuck panel, and it
     is the only sign the request is alive. */
  .dsh-ms-spin { animation-duration:2.5s; }
}
`

    // --- component ---------------------------------------------------------------
    /**
     * The active locale id, kept live so formatters follow it. Falls back to the
     * panel's own language when the host exposes no locale service.
     */
    function useActiveLocale(locale) {
      const read = React.useCallback(
        () =>
          locale !== undefined && typeof locale.getSnapshot === 'function'
            ? (locale.getSnapshot().active ?? FALLBACK_LOCALE)
            : FALLBACK_LOCALE,
        [locale],
      )
      const [active, setActive] = React.useState(read)
      React.useEffect(() => {
        setActive(read())
        if (locale === undefined || typeof locale.subscribe !== 'function') return undefined
        return locale.subscribe(() => setActive(read()))
      }, [locale, read])
      return active
    }

    function Panel({ i18n }) {
      const t = i18n?.t ?? fallbackTranslate
      const locale = useActiveLocale(i18n?.locale)
      const fmt = React.useMemo(() => formattersFor(locale), [locale])
      // Sort, view and the provider filter are the user's settings, not view
      // state: reopening the panel reopens the same question. The payload cache
      // is keyed by the exact query, so restoring the query also restores an
      // instant first paint instead of a spinner.
      // The question the panel opens with: the address first — the more specific
      // statement, and the one a reader typed or followed — then the last choice
      // this browser kept (see `readInitialQuery`).
      const [initialQuery] = React.useState(readInitialQuery)
      const [sort, setSort] = React.useState(initialQuery.sort)
      // The direction is part of the question, not part of the view: it travels
      // in the query string, in the cache key and in the stored preference, so
      // reopening the panel reopens the same order rather than a table that
      // looks reversed next to the arrow it remembers drawing.
      const [dir, setDir] = React.useState(initialQuery.dir)
      const [view, setView] = React.useState(initialQuery.view)
      const [providers, setProviders] = React.useState(initialQuery.providers)
      // The archive is a filter like the provider selection and travels with it
      // — same query string, same store, same cache key — but it is off until it
      // is asked for: a model the harness no longer serves is not a model to
      // pick, and a table that listed one by default would be recommending it.
      const [archived, setArchived] = React.useState(initialQuery.archived)
      // The provider view already has one row per provider, so a filter there
      // could only ever leave a single row. The selection is kept rather than
      // thrown away — it is the answer to a question the user asked in the other
      // view — but it is not sent, and it comes back on the way back.
      const applied = React.useMemo(
        () => (view === 'provider' ? [] : providers),
        [view, providers],
      )
      // The deep metrics start collapsed and the choice sticks to the browser
      // across reopenings: the table answers the question first and keeps the
      // deeper figures one click away.
      const [showAllColumns, setShowAllColumns] = React.useState(() => readPrefs().columnsAll === true)
      // The legend is a footnote, and it starts folded: the table answers its
      // question first.
      const [showLegend, setShowLegend] = React.useState(false)
      // The last answer, whatever query it answered. It is shown immediately
      // when the browser still has it and replaced the moment the host answers;
      // when it is older than the current query it stays on screen and says so.
      const [state, setState] = React.useState(() => {
        // The cache is written under the query that was actually sent, and the
        // provider view sends no filter — so the first lookup has to drop the
        // remembered selection the same way. Looking it up with the selection
        // still on would miss the panel's own entry and paint a spinner over a
        // table this browser already has.
        const asked = initialQuery.view === 'provider' ? [] : initialQuery.providers
        return querySwitched(
          EMPTY_STATE,
          readCachedPayload(initialQuery.sort, initialQuery.dir, initialQuery.view, asked, initialQuery.archived),
          queryKey(initialQuery.sort, initialQuery.dir, initialQuery.view, asked, initialQuery.archived),
        )
      })
      const timedOutRef = React.useRef(false)
      const retriesRef = React.useRef(0)
      const lastPendingRef = React.useRef(0)
      // A background refresh is the panel talking to itself; only a refresh the
      // user asked for is worth announcing.
      const manualRef = React.useRef(false)
      const [announce, setAnnounce] = React.useState('')
      // A live region speaks only when its text changes, so the same sentence
      // twice is silence the second time — and a sweep that is started twice, or
      // a refresh pressed twice, is exactly that case. A zero-width space
      // alternates the string without adding a word to it.
      const announceSeqRef = React.useRef(0)
      const say = React.useCallback((message) => {
        announceSeqRef.current += 1
        setAnnounce(announceSeqRef.current % 2 === 1 ? message : `${message}\u200B`)
      }, [])
      // Every relative time in the panel is computed once per render, so a panel
      // left open would keep saying "2 minutes ago" an hour later. One tick
      // re-renders them while there is an answer to describe, and nothing
      // re-renders when there is not.
      const [, tick] = React.useState(0)
      React.useEffect(() => {
        if (state.data === null || state.data === undefined) return undefined
        const timer = setTimeout(() => tick((value) => value + 1), 30_000)
        return () => clearTimeout(timer)
      }, [state.data])
      // Probe results seen in this browser, keyed by `provider\u0000model`, laid
      // over whatever the last table answer carried. The table's own answer is
      // only refreshed on a query change, so without this a check would not show
      // up until the panel was reopened.
      const [liveOverrides, setLiveOverrides] = React.useState({})
      const [liveJob, setLiveJob] = React.useState({ running: false, total: 0, done: 0, pending: 0 })

      /**
       * Fold one host snapshot into the local view.
       *
       * The host answers a probe sweep as `{ results, checking, running, total,
       * done, pending }`; a single model answered while the sweep is still going
       * arrives the same way, so one reader covers both.
       */
      const absorbLiveness = React.useCallback((payload) => {
        if (payload === null || typeof payload !== 'object') return
        const results = Array.isArray(payload.results) ? payload.results : []
        const checking = new Set(Array.isArray(payload.checking) ? payload.checking : [])
        setLiveOverrides((prev) => {
          const next = { ...prev }
          for (const entry of results) {
            if (typeof entry?.provider !== 'string' || typeof entry?.model !== 'string') continue
            next[`${entry.provider}\u0000${entry.model}`] = entry
          }
          return next
        })
        setLiveJob({
          running: payload.running === true,
          total: Number.isFinite(payload.total) ? payload.total : 0,
          done: Number.isFinite(payload.done) ? payload.done : 0,
          pending: Number.isFinite(payload.pending) ? payload.pending : 0,
          checking,
        })
      }, [])

      /**
       * Ask the host to start probing.
       *
       * The host answers immediately and keeps working, because a sweep over
       * every configured model outlives any request the browser will wait for.
       * Progress is followed by the poll below rather than by holding the
       * response open.
       */
      const startLiveness = React.useCallback(
        async (options = {}) => {
          say(t('announce.liveness.started'))
          livePollsRef.current = 0
          try {
            const response = await fetch('/api/model-stats/liveness/check', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(options),
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const payload = await response.json()
            if (payload.ok === false) throw new Error(payload.error ?? 'unknown error')
            absorbLiveness(payload)
            if ((payload.total ?? 0) === 0) say(t('announce.liveness.none'))
          } catch (error) {
            say(t('liveness.error', { error: failureReason(error, t) }))
          }
        },
        [absorbLiveness, say, t],
      )

      // One poll answers the whole sweep: while the host reports work moving,
      // ask again on a fixed interval and only while it is actually moving, so a
      // finished check costs exactly one extra request. The counter is a leash,
      // not a schedule: a sweep over a large catalog with several dead providers
      // is legitimately minutes long, and a poll that ran forever would turn a
      // stuck host into a browser that never stops asking. It follows the probe
      // budget rather than a number of its own — a route is given the patience
      // its profile declares, up to five minutes of silence, so the leash has to
      // outlast a sweep where several routes take the whole of it.
      const livePollsRef = React.useRef(0)
      const MAX_LIVE_POLLS = 1800
      React.useEffect(() => {
        if (liveJob.running !== true) return undefined
        if (livePollsRef.current >= MAX_LIVE_POLLS) return undefined
        const controller = new AbortController()
        const timer = setTimeout(async () => {
          livePollsRef.current += 1
          try {
            const response = await fetch('/api/model-stats/liveness', { signal: controller.signal })
            if (!response.ok) return
            absorbLiveness(await response.json())
          } catch {
            // A dropped poll is not worth reporting: the next one carries the
            // same facts, and the sweep itself lives on the host.
          }
        }, 1200)
        return () => {
          clearTimeout(timer)
          controller.abort()
        }
      }, [liveJob, absorbLiveness])

      // A failed request must not wipe the table — not for a refresh of the same
      // query, and not for the switch that produced it. The host folds in the
      // background and answers early, so a single hiccup used to replace a
      // perfectly good table with an error line; the switch case was worse,
      // because the rows had already been dropped before the request went out.
      // Keep the last answer and attach a warning; only a failure with nothing
      // to show becomes a full error.
      const fail = React.useCallback((message) => {
        setState((prev) => queryFailed(prev, message))
      }, [])

      const load = React.useCallback(
        async (signal) => {
          const manual = manualRef.current
          manualRef.current = false
          if (manual) say(t('announce.refreshing'))
          setState((prev) => ({
            ...prev,
            phase: prev.data ? 'refreshing' : 'loading',
            warning: null,
            error: null,
          }))
          try {
            // The filter rides in the same query as the sort: one question, one
            // request, and one cache key. It is omitted entirely when nothing is
            // selected, so the unfiltered panel keeps asking exactly what it
            // asked before the filter existed. The direction is always named,
            // even in the key's own — the host is asked for an order, not for
            // whatever it would have done on its own. The archive is named only
            // when it is on, for the same reason: `archived=1` is the filter,
            // and its absence is the default. The page size is named for that
            // reason too (see `PAGE_ROWS`): a table that lists the configuration
            // cannot be drawn on a host's own idea of a page.
            const names = applied.length > 0 ? `&provider=${encodeURIComponent(applied.join(','))}` : ''
            const archiveParam = archived ? '&archived=1' : ''
            const query = `?sort=${encodeURIComponent(sort)}&dir=${encodeURIComponent(dir)}&view=${encodeURIComponent(view)}${names}${archiveParam}&limit=${PAGE_ROWS}`
            const response = await fetch(`/api/model-stats${query}`, { signal })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const data = await response.json()
            if (data.ok === false) throw new Error(data.error ?? 'unknown error')
            writeCachedPayload(sort, dir, view, applied, archived, data)
            setState(queryAnswered(data, queryKey(sort, dir, view, applied, archived)))
            if (manual) say(t('announce.updated'))
          } catch (error) {
            if (error && error.name === 'AbortError') {
              // A user-visible deadline, not an unmount: say so instead of
              // leaving the spinner up forever.
              if (timedOutRef.current) {
                fail(
                  t('timeout.reason', { seconds: Math.round(REQUEST_TIMEOUT_MS / 1000) }),
                )
              }
              return
            }
            fail(failureReason(error, t))
          }
        },
        [sort, dir, view, applied, archived, fail, say, t],
      )

      // Announce the end of a sweep once, from the transition rather than from
      // every poll — the same sentence twenty times is not progress.
      //
      // The same transition is when the table's own answer goes stale. Rows are
      // fetched with a `livenessChecking` flag the host computed when it answered,
      // so a table read taken during a sweep keeps saying "checking" for models
      // the sweep has since finished — and the status column reads that flag. One
      // refetch replaces the claim with the result instead of leaving a spinner
      // that only a manual refresh clears.
      const wasRunningRef = React.useRef(false)
      React.useEffect(() => {
        const running = liveJob.running === true
        if (wasRunningRef.current && !running && liveJob.total > 0) {
          let ok = 0
          for (const entry of Object.values(liveOverrides)) if (entry?.status === 'ok') ok += 1
          say(t('announce.liveness.done', { ok: fmt.count(ok), total: fmt.count(liveJob.total) }))
          void load()
        }
        wasRunningRef.current = running
      }, [liveJob, liveOverrides, say, t, fmt, load])

      React.useEffect(() => {
        // Switching the sort, the direction, the view, the provider filter or
        // the archive switches the query: show what the browser already has for
        // the new one, and when it has nothing, keep the rows that are already on
        // screen rather than blanking the panel while the host is asked.
        setState((prev) =>
          querySwitched(
            prev,
            readCachedPayload(sort, dir, view, applied, archived),
            queryKey(sort, dir, view, applied, archived),
          ),
        )

        const controller = new AbortController()
        timedOutRef.current = false
        retriesRef.current = 0
        lastPendingRef.current = 0
        const timer = setTimeout(() => {
          timedOutRef.current = true
          controller.abort()
        }, REQUEST_TIMEOUT_MS)
        load(controller.signal)
        return () => {
          clearTimeout(timer)
          controller.abort()
        }
      }, [load, sort, dir, view])

      // The host answers from its cache first and refreshes behind it, so an
      // early answer can still be catching up. Keep asking — quietly, and only
      // while the work is actually moving — until it stops changing.
      React.useEffect(() => {
        if (state.phase !== 'ready') return undefined
        const data = state.data
        const busy = (data?.pending ?? 0) > 0 || (data?.readNow ?? 0) > 0
        if (!busy) return undefined
        // A refresh is worth one round when the host just folded something the
        // answer cannot yet contain; after that, only real progress counts.
        const stamp = `${data?.pending ?? 0}:${data?.readNow ?? 0}:${data?.snapshotAt ?? 0}`
        if (retriesRef.current > 0 && stamp === lastPendingRef.current) return undefined
        if (retriesRef.current >= MAX_REFRESHES) return undefined
        lastPendingRef.current = stamp
        const timer = setTimeout(() => {
          retriesRef.current += 1
          load()
        }, REFRESH_INTERVAL_MS)
        return () => clearTimeout(timer)
      }, [state, load])

      const rows = Array.isArray(state.data?.rows) ? state.data.rows : []
      // The pairs a probe is running for right now, as the host named them, and
      // the one flag every liveness control reads. Both are derived rather than
      // stored: a control that kept its own copy of "busy" would drift from the
      // host's own count the moment a sweep ended on its own.
      const checkingSet = liveJob.checking instanceof Set ? liveJob.checking : EMPTY_SET
      const liveRunning = liveJob.running === true
      // Green and red are two ends of the same comparison, so they are decided
      // in one pass over one pair of rankings: a table that coloured the best
      // median and the worst median by different rules would mark one row both
      // ways, or none.
      //
      // The ranking is over the rows on screen, not over the whole history: a
      // model that is last of three is the worst of what the reader can see,
      // and the legend says so. A single row is left unmarked on both ends —
      // with nothing to compare against it is neither the best nor the worst.
      const ranked = React.useMemo(() => {
        const none = { best: {}, worst: {} }
        if (rows.length < 2) return none
        const slower = (a, b) => a < b
        const faster = (a, b) => a > b
        return {
          best: {
            ttft: extremeRow(rows, (r) => r.ttftMedian, slower),
            tps: extremeRow(rows, (r) => r.tpsMedian, faster),
          },
          worst: {
            ttft: extremeRow(rows, (r) => r.ttftMedian, faster),
            tps: extremeRow(rows, (r) => r.tpsMedian, slower),
          },
        }
      }, [rows])

      // The two headline columns carry their own scale (see `measurementScale`):
      // the largest value in a column is the full width of its bar, and every
      // other row is that value's share of it. One row alone has nothing to be
      // compared with and is left without one.
      const scale = React.useMemo(() => {
        const widest = { rows: rows.length, ttft: 0, tps: 0 }
        for (const row of rows) {
          if (finite(row.ttftMedian) && row.ttftMedian > widest.ttft) widest.ttft = row.ttftMedian
          if (finite(row.tpsMedian) && row.tpsMedian > widest.tps) widest.tps = row.tpsMedian
        }
        return widest
      }, [rows])

      // The providers the filter can offer, taken from the answer rather than
      // from the rows on screen: the rows are sorted, cut to the limit and
      // already filtered, so they name a handful of the providers in the history
      // — and the ones a filter exists to compare are exactly the ones missing.
      // A selection the current answer does not know stays in the list, or the
      // control would show a filter it cannot offer to lift.
      const knownProviders = React.useMemo(() => {
        const list = Array.isArray(state.data?.providerList) ? state.data.providerList : []
        const entries = []
        const seen = new Set()
        const add = (entry) => {
          if (typeof entry?.provider !== 'string' || entry.provider === '') return
          if (seen.has(entry.provider)) return
          seen.add(entry.provider)
          entries.push(entry)
        }
        for (const entry of list) add(entry)
        // An answer from a host that predates the filter — a cached payload
        // written before it existed — carries no list; the rows still name the
        // providers that are in it.
        for (const row of rows) add({ provider: row.provider, models: null, steps: row.steps })
        for (const name of providers) add({ provider: name, models: null, steps: null })
        // Alphabetical, so a provider is found where its name says it is. The
        // host sends its list busiest first, and that is the right order for
        // reading a ranking and the wrong one for finding a checkbox: the list
        // mixes providers of very different traffic, so a name moves between
        // two answers and has to be hunted for again. The name is the only key
        // a row here has that does not change under the reader, so it is the
        // one the order is built on. `steps` stays on the row itself, beside
        // the name, where it explains the table without ordering it.
        return entries.sort((a, b) => a.provider.localeCompare(b.provider))
      }, [state.data, rows, providers])

      // The name of an order in a sentence: the heading of the column that sorts
      // by it — «отклик med» says which figure the rows are in, not just which
      // end of it is on top — so it is what a warning about a stale order and an
      // announcement of a new one both use. Every order the panel can hold is a
      // column's own sort key, so the lookup is total; the guard keeps a stray
      // key from crashing the sentence.
      const orderName = (key) => {
        const column = COLUMNS.find((entry) => entry.sort === key)
        if (column === undefined) return key
        return t(typeof column.labelKey === 'function' ? column.labelKey(view) : column.labelKey)
      }

      // Choosing a sort, a view or a provider is a lasting decision, so it is
      // written down as it is made — never in an effect keyed on the value,
      // which would also rewrite the default on a panel the user only glanced at.
      const applyOrder = (nextSort, nextDir) => {
        setSort(nextSort)
        setDir(nextDir)
        writePrefs({ sort: nextSort, dir: nextDir })
        writeUrlQuery(nextSort, nextDir, view, applied, archived)
        // A new order moves every row in the table and the arrow is the only part
        // of that a screen reader would otherwise have to go looking for, so the
        // order is named out loud on the same channel the refresh uses.
        say(t('announce.sorted', { column: orderName(nextSort), direction: t(`sort.direction.${nextDir}`) }))
      }
      // A heading asks for its own column. Clicking the column that is already
      // the order turns it around; clicking any other one starts it where that
      // column is read from. The two are the same question asked of the host
      // either way, so they share this one handler and one set of rules.
      const chooseColumn = (key) => {
        applyOrder(key, key === sort ? flipDirection(dir) : (SORT_DIRS[key] ?? DEFAULT_QUERY.dir))
      }
      const chooseView = (next) => {
        setView(next)
        writePrefs({ view: next })
        // The provider view sends no filter, so the address has to name what is
        // sent rather than what is remembered. The archive is not a provider
        // selection and is sent in both views, so it stays named either way.
        writeUrlQuery(sort, dir, next, next === 'provider' ? [] : providers, archived)
      }
      const chooseProvider = (name) => {
        const next = normalizeProviders(
          providers.includes(name) ? providers.filter((entry) => entry !== name) : [...providers, name],
        )
        setProviders(next)
        writePrefs({ providers: next })
        writeUrlQuery(sort, dir, view, next, archived)
      }
      // The archive is one checkbox and one decision, and it is written down the
      // way the sort is: the reader chose it, so it outlives the panel.
      const chooseArchive = (next) => {
        setArchived(next)
        writePrefs({ archived: next })
        writeUrlQuery(sort, dir, view, applied, next)
      }
      // "Reset" resets the filter, and the archive is a filter: a button that
      // lifted half of what the panel is filtering by would leave the reader
      // hunting for the other half.
      const clearFilter = () => {
        setProviders([])
        setArchived(false)
        writePrefs({ providers: [], archived: false })
        writeUrlQuery(sort, dir, view, [], false)
      }

      // The provider filter, drawn only where it means something: in the
      // provider view a row already is a provider.
      const selected = React.useMemo(
        () => (applied.length === 0 ? t('filter.all') : t('filter.selection', {
          selected: fmt.count(applied.length),
          total: fmt.count(knownProviders.length),
        })),
        [applied, knownProviders, t, fmt],
      )
      // What the host says the archive holds, and whether it can say at all.
      // `null` — a configuration this host could not read — and `undefined` — a
      // host that predates the field — both mean the control is not offered;
      // neither is an empty archive, and a checkbox that could only ever read
      // zero would be a promise this panel cannot keep.
      const archiveInfo = state.data?.archive ?? null
      const archiveRows = archiveInfo === null ? 0 : (archiveInfo.rows ?? 0)
      const archiveControl =
        archiveInfo === null
          ? null
          : h(
              'label',
              { className: 'dsh-ms-filter-row dsh-ms-filter-archive' },
              h('input', {
                type: 'checkbox',
                name: 'archived',
                value: '1',
                autoComplete: 'off',
                checked: archived,
                onChange: () => chooseArchive(!archived),
              }),
              h('span', { className: 'dsh-ms-filter-name' }, t('filter.archive')),
              h(
                'span',
                { className: 'dsh-ms-filter-count', 'aria-hidden': 'true' },
                t('filter.archive.count', { count: fmt.count(archiveRows) }),
              ),
            )
      // The selection is bounded (see `MAX_PROVIDERS`), so the bound is a fact
      // the control shows rather than one it applies behind the reader's back:
      // at the cap the providers outside the selection stop taking marks, and
      // the line under the list says why.
      const atCap = providers.length >= MAX_PROVIDERS
      const filterControl =
        view === 'provider'
          ? null
          : h(
              'details',
              { className: 'dsh-ms-filter' },
              h(
                'summary',
                { className: 'dsh-ms-chip' },
                `${t('filter.label')}: ${selected}` +
                  (archived ? ` + ${t('filter.archive.short')}` : ''),
              ),
              h(
                'div',
                { className: 'dsh-ms-filter-panel', role: 'group', 'aria-label': t('filter.group') },
                archiveControl,
                knownProviders.length === 0
                  ? h('div', { className: 'dsh-ms-filter-note' }, t('filter.empty'))
                  : h(
                      'div',
                      { className: 'dsh-ms-filter-list' },
                      ...knownProviders.map((entry) =>
                        h(
                          'label',
                          { className: 'dsh-ms-filter-row', key: entry.provider },
                          h('input', {
                            type: 'checkbox',
                            name: 'provider',
                            value: entry.provider,
                            autoComplete: 'off',
                            checked: providers.includes(entry.provider),
                            disabled: atCap && !providers.includes(entry.provider),
                            onChange: () => chooseProvider(entry.provider),
                          }),
                          // Machine names are not phrases to hand to a translator.
                          // The count beside the name is part of the checkbox's own
                          // name through the label, so it is hidden from the reader
                          // who hears one.
                          h('span', { className: 'dsh-ms-filter-name', translate: 'no' }, entry.provider),
                          h(
                            'span',
                            { className: 'dsh-ms-filter-count', 'aria-hidden': 'true' },
                            Number.isFinite(entry.steps)
                              ? t('filter.steps', { count: fmt.count(entry.steps) })
                              : null,
                          ),
                        ),
                      ),
                    ),
                atCap
                  ? h(
                      'div',
                      { className: 'dsh-ms-filter-note' },
                      t('filter.cap', { max: fmt.count(MAX_PROVIDERS) }),
                    )
                  : null,
                applied.length === 0 && !archived
                  ? null
                  : h(
                      'button',
                      { type: 'button', className: 'dsh-ms-chip', onClick: clearFilter },
                      t('filter.reset'),
                    ),
              ),
            )

      // Sorting lives in the column headings, so the bar holds only the filter
      // and the toggles — nothing that would name a second place to sort from.
      //
      // The two liveness buttons are the two halves of the same question. "Check
      // stale only" is the cheap one and the one a repeat press benefits from: a
      // fresh answer is not paid for twice, so clicking it again finishes a sweep
      // that was interrupted. "Check all" is the explicit re-run, for when the
      // reader does not trust a result from minutes ago.
      // The bar is three clusters, and each one answers a different question:
      // what to compare (the filter), whether the models answer at all (the two
      // halves of one probe question), and how to read the rows (the view and the
      // column set). The caption is what makes a row of identical chips legible
      // as those three things rather than as six equal buttons.
      const toolbar = h(
        'div',
        { className: 'dsh-ms-bar' },
        filterControl,
        h(
          'span',
          { className: 'dsh-ms-group' },
          h('span', { className: 'dsh-ms-group-label' }, t('probe.label')),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ms-chip',
              'aria-disabled': liveRunning,
              onClick: () => {
                if (liveRunning) return
                void startLiveness({ all: true })
              },
            },
            liveRunning && liveJob.pending > 0
              ? t('liveness.pending', { count: fmt.count(liveJob.pending) })
              : t('action.liveness.all'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ms-chip',
              'aria-disabled': liveRunning,
              onClick: () => {
                if (liveRunning) return
                void startLiveness({ staleOnly: true })
              },
            },
            t('action.liveness.stale'),
          ),
        ),
        h('span', { style: { flex: '1 0 auto' } }),
        h(
          'span',
          { className: 'dsh-ms-group' },
          h('span', { className: 'dsh-ms-group-label' }, t('view.label')),
          // The chip names the view that is on, the caption says it is a choice,
          // and the tooltip says what pressing it does — "по моделям" on a button
          // is otherwise a statement where an action is expected.
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ms-chip',
              title: t('view.switch'),
              onClick: () => chooseView(view === 'model' ? 'provider' : 'model'),
            },
            t(view === 'model' ? 'view.models' : 'view.providers'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ms-chip',
              'aria-pressed': showAllColumns,
              onClick: () => {
                const next = !showAllColumns
                setShowAllColumns(next)
                writePrefs({ columnsAll: next })
              },
            },
            t('columns.all'),
          ),
        ),
      )

      const visible = COLUMNS.filter(
        (column) => column.key === 'liveness' || column.tier !== 'extra' || showAllColumns,
      )

      // The order the rows on screen are really in. While a request is in flight
      // the rows on screen are still the previous answer and the heading follows
      // the question the reader just asked — the notice above the table says whose
      // answer is on screen. Once the answer for *this* question has arrived, the
      // host's own echo decides: it is the one field that can contradict the
      // question, and a host that does not know the key answers another order
      // rather than failing the request. Without this, the one query a
      // not-yet-reloaded host cannot serve — a heading added by a newer panel —
      // would draw its arrow over rows that are in a different order, and say so
      // to a screen reader besides.
      const answered = state.dataQuery === queryKey(sort, dir, view, applied, archived)
      const orderOnScreen =
        answered && typeof state.data?.sort === 'string' ? state.data.sort : sort

      const header = h(
        'thead',
        null,
        h(
          'tr',
          null,
          ...visible.map((column) => {
            const hint =
              typeof column.hintKey === 'function' ? column.hintKey(view) : column.hintKey
            const hintText = hint === undefined ? null : t(hint)
            const label = t(
              typeof column.labelKey === 'function' ? column.labelKey(view) : column.labelKey,
            )
            // The arrow follows the answer, not the question (see
            // `orderOnScreen`): the order on screen is the one the host said it
            // applied, so a heading can never claim an order its rows are not in.
            const active = column.sort === orderOnScreen
            return h(
              'th',
              {
                key: column.key,
                scope: 'col',
                className: [column.align === 'left' ? 'dsh-ms-left' : '', column.groupStart ? 'dsh-ms-group-start' : ''].filter(Boolean).join(' '),
                // The sort state belongs on the cell, not on the button inside it:
                // this is the property a screen reader announces when the cursor
                // enters the column, and `none` says out loud that the other
                // columns are not sorted — which is the fact a table of sortable
                // headings otherwise leaves to be inferred from a single arrow.
                'aria-sort': active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none',
                // A heading is not focusable, so the browser tooltip is the one
                // route this explanation cannot travel: the same sentence is
                // repeated as hidden text, which is where a screen reader — and
                // anything else that reads the markup — gets it.
                title: hintText ?? undefined,
              },
              // A real button, so the heading is reachable by Tab and answers to
              // Enter and Space without the table growing a key handler of its
              // own. A column that declares no order renders as plain text, and
              // then the dotted underline below is the only hint it gives.
              column.sort === undefined
                ? label
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-ms-sort',
                      onClick: () => chooseColumn(column.sort),
                    },
                    label,
                    // The arrow repeats what `aria-sort` already says, for the
                    // reader who can see the table and not hear it. It is empty
                    // on the columns that are not the order, so a table with one
                    // arrow in it cannot be misread as three.
                    h(
                      'span',
                      { className: 'dsh-ms-arrow', 'aria-hidden': 'true' },
                      active ? (dir === 'asc' ? '▲' : '▼') : '',
                    ),
                  ),
              hintText === null ? null : h('span', { className: 'dsh-ms-sr-only' }, ` — ${hintText}`),
            )
          }),
        ),
      )

      const body = h(
        'tbody',
        null,
        ...rows.map((row) => {
          const key = `${row.provider}/${row.model}`
          const cell = livenessView(row, liveOverrides, checkingSet, t, fmt)
          const ctx = {
            view, best: ranked.best, worst: ranked.worst, t, fmt, scale,
            renderLiveness() {
              // An unclassified failure has no word of its own and prints the host's
              // status; everything else is this panel's own copy.
              const label = cell.labelRaw ?? t(cell.labelKey)
              const labelProps = { className: 'dsh-ms-live-label', 'data-state': cell.state }
              // That status is a machine id, not copy: nothing should translate it.
              if (cell.labelRaw !== null) labelProps.translate = 'no'
              const facts = cell.facts.join(' · ')
              // The tooltip is the whole story, in both column sets: what the
              // check saw, what it was refused with, and — when the circle is
              // green because history outranked the check — why.
              const note = cell.seenAfterCheck ? t('liveness.fromHistoryTitle') : ''
              const title = [facts, cell.detail, note].filter((part) => part !== '').join(' · ')
              const aria = `${t('liveness.status')}: ${label}${facts === '' ? '' : `. ${facts}`}${cell.detail === '' ? '' : `. ${cell.detail}`}`
              return h(
                'span',
                { className: 'dsh-ms-live' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-ms-live-button',
                    title: title === '' ? undefined : title,
                    'aria-label': aria,
                    'aria-disabled': cell.inFlight,
                    onClick: () => {
                      if (cell.inFlight) return
                      void startLiveness(
                        view === 'provider'
                          ? { provider: row.provider }
                          : { provider: row.provider, model: row.model },
                      )
                    },
                  },
                  h('span', {
                    className: 'dsh-ms-live-dot',
                    'data-state': cell.state,
                    'aria-hidden': 'true',
                  }),
                  h('span', labelProps, label),
                ),
                // The evidence line is the first thing the short column set
                // gives up. There the table answers "which model", one line per
                // row, and the circumstances of the check stay one hover away
                // instead of widening a cell every row has to share.
                cell.facts.length === 0 || !showAllColumns
                  ? null
                  : h('span', { className: 'dsh-ms-live-meta' }, facts),
              )
            },
          }
          return h(
            'tr',
            { key },
            ...visible.map((column) =>
              h(
                'td',
                {
                  key: column.key,
                  className: column.key === 'name' ? 'dsh-ms-model' : cellClass(column, row, ctx),
                  'data-group-start': column.groupStart || undefined,
                },
                column.cell(row, ctx),
              ),
            ),
          )
        }),
      )

      const totals = state.data?.totals
      const pending = state.data?.pending ?? 0
      // What the filter kept, as the host counted it over the filtered rows.
      // Only shown when a filter is on: without one it would repeat the totals
      // line, and the totals line is about the whole history, not the table.
      const shown =
        applied.length > 0 && state.data !== null && state.data !== undefined && state.data.shown
          ? { view, models: state.data.shown.models, steps: state.data.shown.steps }
          : null
      // A real `disabled` takes the button out of the tab order and drops the
      // focus of whoever just pressed it. The busy state is expressed with
      // aria-disabled plus a guarded handler instead, so the control stays
      // focusable and the keyboard user keeps their place.
      const refreshing = state.phase === 'loading' || state.phase === 'refreshing'
      const footer = h(
        'div',
        { className: 'dsh-ms-foot' },
        h(
          'span',
          { className: 'dsh-ms-meta' },
          state.data ? footerSummary(state.data, totals, pending, t, fmt, shown) : '',
        ),
        h('span', { style: { flex: '1 0 auto' } }),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-ms-btn',
            'aria-disabled': refreshing,
            onClick: () => {
              if (refreshing) return
              manualRef.current = true
              load()
            },
          },
          refreshing ? h('span', { className: 'dsh-ms-spin', 'aria-hidden': 'true' }) : null,
          t(state.phase === 'refreshing' ? 'action.refreshing' : 'action.refresh'),
        ),
      )

      // What is on screen may answer an older query than the one selected: the
      // panel says which wait it is in instead of passing the old order off as
      // the new one. The filter is named with it — a stale table of every
      // provider must not be read as a stale table of the selected ones.
      const currentKey = queryKey(sort, dir, view, applied, archived)
      const behind = state.data !== null && state.data !== undefined && state.dataQuery !== currentKey
      const sortLabel = orderName(sort)
      // The archive is named here for the same reason the provider selection is:
      // a stale table of every model must not be read as a stale table of the
      // ones the reader asked for, and "the archive is on" is part of what was
      // asked for. The provider half is dropped when nothing is selected, so the
      // note of an archive-only filter reads as the one thing it filtered by.
      const filterParts = [
        applied.length === 0
          ? null
          : t('filter.note', {
              selected: fmt.count(applied.length),
              total: fmt.count(knownProviders.length),
            }),
        archived ? t('filter.archive.short') : null,
      ].filter((part) => part !== null)
      const filterNote = filterParts.length === 0 ? '' : ` (${filterParts.join(', ')})`

      const kind = contentKind(rows, state)
      let content
      if (kind === 'table') {
        content = h('div', { className: 'dsh-ms-wrap' }, h('table', { className: 'dsh-ms-table' }, header, body))
      } else if (kind === 'error') {
        // A failure wears the alert's shape in the error's own colour: a request
        // that got no answer is not a warning to live with, and it is not an
        // empty table either.
        content = h(
          'div',
          { className: 'dsh-ms-alert dsh-ms-failed', role: 'alert' },
          t('error.body', { error: state.error }),
        )
      } else if (kind === 'loading') {
        content = h('div', { className: 'dsh-ms-empty', role: 'status' }, t('loading.body'))
      } else {
        content = h(
          'div',
          { className: 'dsh-ms-empty' },
          // An empty table under a filter is not an empty history, and telling
          // the user to go work in a session is the wrong advice: the sessions
          // are there, just not the ones behind the selected providers. The
          // archive is asked first because it is the only one of the two that
          // names its own remedy — a table emptied by the archive is one
          // checkbox away from having rows.
          archiveRows > 0 && !archived
            ? t('empty.archived', {
                count: fmt.count(archiveRows),
                archive: t('filter.archive.short'),
              })
            : applied.length > 0
              ? t('empty.filtered')
              : pending > 0
                ? t('empty.pending', {
                    scanned: fmt.count(state.data.scanned),
                    pending: fmt.count(pending),
                  })
                : t('empty.nodata'),
        )
      }

      // A failure keeps the table and explains itself; a request still in flight
      // for another query only needs to say that the order on screen is the one
      // it already had. Both are announcements, neither replaces the rows.
      const alert =
        kind !== 'table'
          ? null
          : state.warning
            ? h(
                'div',
                { className: 'dsh-ms-alert', role: 'status' },
                behind
                  ? t('warn.stale', { sort: sortLabel, filter: filterNote, warning: state.warning })
                  : t('warn.body', { warning: state.warning }),
              )
            : behind
              ? h(
                  'div',
                  { className: 'dsh-ms-alert dsh-ms-quiet', role: 'status' },
                  t('status.updating', { sort: sortLabel, filter: filterNote }),
                )
              : null

      return h(
        'div',
        {
          className: 'dsh-ms-root',
          // One element says the whole panel is waiting on the host, for a reader
          // who arrives while the first pass is still running.
          'aria-busy': refreshing ? true : undefined,
        },
        h('style', null, css),
        // One channel for the async work the user started, so a background poll
        // stays silent while a requested refresh is announced politely.
        h('span', { className: 'dsh-ms-sr-only', role: 'status' }, announce),
        h(
          'div',
          { className: 'dsh-ms-head' },
          // The bundle's page names the plugin above this panel; inside it this
          // heading names what the table shows, so it is a heading, not
          // decorative text.
          h('h2', { className: 'dsh-ms-title' }, t('panel.title')),
          h('span', { className: 'dsh-ms-meta' }, t('panel.subtitle')),
        ),
        // Always mounted, so starting a request never moves the table: the rule is
        // there either way and only the sweep on it comes and goes.
        h(
          'div',
          { className: 'dsh-ms-sweep', 'data-busy': refreshing ? 'true' : 'false', 'aria-hidden': 'true' },
          h('span', { className: 'dsh-ms-sweep-fill' }),
        ),
        toolbar,
        alert,
        content,
        footer,
        // The legend is a footnote and it is folded away: the table answers its
        // question first, and this line is the signpost to the rule behind it.
        // Folded with `hidden`, so a reader who does not ask for it does not hear
        // it either.
        h(
          'div',
          { className: 'dsh-ms-legend' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ms-legend-toggle',
              'aria-expanded': showLegend,
              onClick: () => setShowLegend((open) => !open),
            },
            t('legend.summary'),
          ),
          h(
            'div',
            { className: 'dsh-ms-note', hidden: !showLegend },
            t('note.core') + (showAllColumns ? t('note.extra') : t('note.collapsed')),
          ),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.get('slots')
        if (slots === undefined) return

        // The host locale service is resolved on first use rather than here: the
        // panel is only rendered once the bundle's page in the Plugins section is
        // opened, by which point a service provided later in the boot sequence is
        // guaranteed to exist. Without one, the panel keeps its own copy (see
        // bindPanelLocale).
        let bound = null
        const i18n = () => {
          if (bound === null) bound = bindPanelLocale(ctx)
          return bound
        }

        // The table is this bundle's own configuration page in the Plugins
        // section: `plugins.bundle.config`, keyed by the bundle's package name,
        // renders it on the bundle's page between its description and its rows.
        // That page is the reason for the move — the settings dialog this panel
        // used to be a section of was too narrow for a table of nowrap numbers.
        // The page draws the title, the icon and the crumb itself; the entry
        // contributes the panel alone, and only for `view: 'page'` — the slot's
        // own contract renders bundle configuration no other way. The slot is
        // declared by the Plugins page while that page is installed, so this
        // inject waits for the declaration instead of racing it.
        slots.inject('plugins.bundle.config', () =>
          slots.register(
            {
              name: 'plugins.bundle.config',
              key: BUNDLE_NAME,
            },
            (props) =>
              props.view === 'page' ? h(Panel, { ...props, i18n: i18n() }) : null,
          ),
        )
      },
      // The state machine and the dictionaries, reachable from a repository
      // test. This half is browser-only — no build step, so nothing imports it —
      // and `tools/verify-panel-state.mjs` drives the registered page instead of
      // describing it. The module loader reads `inject` and `apply` and ignores
      // everything else.
      __test__: { MESSAGES, contentKind, querySwitched, queryAnswered, queryFailed },
    }
  },
})
