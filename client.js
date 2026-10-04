// dsh-model-scorecard - Client half.
//
// A panel on this bundle's page in the Plugins section, over the host's
// `GET /api/model-scorecard`. It renders the same
// aggregation the `model_stats` tool returns, so what the agent reads and what
// the human sees cannot drift apart.
//
// The factory is lazy and side-effect free: all fetching happens in effects on
// the mounted component, and the stylesheet travels in the rendered tree — a
// panel nobody opens costs no style of its own.

window.__ModuleLoader__.load({
  id: 'dsh-model-scorecard',
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
      tools: 'desc',
      toolTime: 'asc',
      errorRate: 'desc',
      modelErrors: 'desc',
      interrupted: 'desc',
      // The rating is a measurement like the rest — 0-100, higher is a route that
      // delivered better here — so it opens at the good end, and the reader who
      // clicks the heading is asking which pair to use rather than which to avoid.
      rating: 'desc',
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

    // The question a panel with nothing remembered asks. It holds no selection: the
    // rule a first open uses is the default rule document (`defaultSelectionRules`),
    // which is a policy and not a list of pairs, and spelling it here as one more
    // empty field would invite a caller to pass `[]` for "nothing selected" — the one
    // reading this panel must never give that value.
    const DEFAULT_QUERY = { sort: 'ttft', dir: SORT_DIRS.ttft, view: 'model' }

    // --- localized copy ----------------------------------------------------------
    // The panel follows the host's locale service: its dictionaries are registered
    // under this package's namespace and read back through a bound translate
    // function, so the panel switches language together with the rest of the GUI,
    // and a language pack can override any key. Without that service — an older
    // host — the built-in Russian copy below keeps the panel complete.
    const I18N_NS = 'dsh-model-scorecard'
    const FALLBACK_LOCALE = 'ru'
    // The bundle's package name, and therefore the key `plugins.bundle.config`
    // dispatches on: the Plugins page asks for this bundle's page under the same
    // name the profile installed and the loader row carries.
    const BUNDLE_NAME = 'dsh-model-scorecard'

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
        'hint.columns.all':
          'Показывает все столбцы, а не только основные: отклик p90, tok/s max, «замер», llm / шаг, префилл, «наш оверхед», кэш, ретраи, «виден» и остальные. Нажмите ещё раз, чтобы вернуть краткий набор. Выбор запоминается и переживает перезагрузку страницы.',
        'models.open': 'Модели',
        'models.count': '{selected} из {total}',
        'models.group': 'Выбор моделей',
        'models.search': 'Поиск по провайдеру или модели',
        'models.selectAll': 'Выбрать все',
        'models.selectNone': 'Снять все',
        'models.reset': 'Вернуть выбор по умолчанию',
        'models.resetDefault': 'Вернуть выбор по умолчанию',
        'models.empty': 'Ничего не найдено по этому запросу.',
        'models.providerCount': '{selected} из {total} моделей',
        'models.provider.measured':
          'Правило провайдера «только измеренные»: выбраны те его модели, у которых есть история. Модель, которую запустят впервые, сама не появится.',
        'models.note': 'выбрано моделей: {selected} из {total}',
        'models.truncated': 'Показаны {shown} из {total} выбранных строк.',
        'models.showAll': 'Показать все',
        // The rows drawn against the rows the answer carries. Deliberately not the
        // same sentence as `models.truncated`: that one is about what the host sent
        // and ends in an offer to ask for the rest, this one is about what is on the
        // page and ends in an offer to draw more of what already arrived.
        'models.painted': 'На экране первые {shown} из {total} строк.',
        'models.paintMore': 'Ещё {count}',
        'models.storage':
          'Браузер не разрешает сохранять данные: выбор действует, пока открыта вкладка, и не переживёт её закрытие.',
        'models.unknownCatalog':
          'Каталог этой установки прочитать не удалось: в дереве только то, что есть в истории, и архив не размечен.',
        'empty.selection': 'Модели не выбраны.',
        'empty.selected':
          'У выбранных моделей нет замеров в истории: снимите отметку или выберите другую модель.',
        'announce.selection.reset': 'Выбор моделей сброшен к выбору по умолчанию.',
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
        'column.tools': 'инстр./шаг',
        'column.toolTime': 'инстр. с/шаг',
        'column.lastSeen': 'виден',
        'column.liveness': 'статус',
        'column.rating': 'рейтинг',
        'probe.label': 'Проверка',
        'action.liveness.all': 'Проверить все',
        'action.liveness.selected': 'Проверить выбранные',
        'action.liveness.provider': 'Проверить провайдера',
        // The two buttons used to be "check all" and "check the stale ones", and
        // the second said nothing a reader could act on: what counted as stale was
        // a five-minute window inside the host, and a button that skips what it
        // cannot show is a button whose result cannot be predicted. Both halves now
        // name their scope — the catalog, or the ticked models — and the tooltip
        // says what each one costs, because the difference between them is one real
        // request per model.
        'hint.liveness.all':
          'Опрашивает все настроенные модели, включая те, что проверены меньше пяти минут назад. Каждая проверка — настоящий запрос к модели тем же путём, что и работа: один короткий запрос, и зелёный кружок означает, что харнесс до модели дотягивается. Нажатие во время проверки ничего не делает — дождитесь окончания.',
        'hint.liveness.selected':
          'Опрашивает только те модели, что отмечены в дереве «Модели», — и повторно, даже если модель проверяли меньше пяти минут назад: нажатие просит именно эти модели прямо сейчас. Пустой выбор отключает кнопку: проверять нечего. Отдельную модель проверяет её кружок в столбце «статус».',
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
          'Число ошибок на 100 шагов: нормализовано по активности, в отличие от общего счётчика. Это не процент неудачных запросов и не оценка качества модели: за шаг бывает несколько ошибок, а сложность задач и причины отказов различаются. Число не равно доле неудачных запросов: один шаг может содержать несколько ошибок, а причины ошибок бывают у модели, провайдера или самого харнесса. Полоска под числом — доля от наибольшего значения в этом столбце; она намеренно серая, потому что сама по себе частота не винит ни модель, ни провайдера.',
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
        'hint.tools':
          'Сколько вызовов инструментов приходится на один шаг этой модели. Считается по всем её шагам, поэтому шаг, где инструмент не вызывался, — честный ноль, а не пробел: сравниваются модели целиком, а не только те шаги, где инструмент понадобился. Это объём работы, а не качество: больше вызовов не значит лучше. Считаются только те вызовы, которые вернули результат; вызов, на который ответа не было, не попадает ни в одну цифру колонки. «-» означает, что у модели нет ни одного шага.',
        'hint.toolTime':
          'Медиана того, сколько времени ждал один шаг этой модели, пока выполнялись вызванные им инструменты: от `tool/call` до `tool/result`. Это время инструмента, а не модели — здесь лежит и работа песочницы (`bash` — около 2,8 с на вызов), и ожидание человека (`ask_user_question` — сотни секунд на вызов). Сами миллисекунды модели ничего не говорят: колонка нужна, чтобы увидеть, сколько всего цикл агента тратит между двумя вызовами модели, и разбивка по инструментам отдаётся в ответе панели. Время инструментов не входит во «наш оверхед» и во время шага: лог закрывает шаг сообщением модели, а ответ инструмента приходит после. Медиана берётся только по шагам, где инструмент вызывался, поэтому у модели, чьи шаги обходятся без него, стоит «-», а не 0 мс.',
        'hint.lastSeen': 'Когда модель отвечала в последний раз — по всем сессиям в истории.',
        // The rating is the one column whose figure is a verdict rather than a
        // reading, so its heading carries the whole rule: what is counted, what is
        // thrown away, why an old measurement still counts, and what the mark next
        // to the number means. It is also the paragraph the screen reader gets,
        // which is why it is written as a sentence and not as a legend.
        'hint.rating':
          'Технический рейтинг этой пары провайдер–модель, 0–100. Учитывает скорость генерации, типичный и медленный отклик. Берётся вся история, а вес замера уменьшается вдвое за 30 дней относительно самого нового подходящего. Шаги с повторами и прерываниями исключены. Не оценивает интеллект, доступность, цену или размер контекста. Рейтинг публикуется от 10 подходящих замеров и помечается «~», пока эффективная выборка или число сессий малы, и «*», если самый новый подходящий замер старше 30 дней: оценка остаётся исторической и не пересчитывается от давности. «-» означает, что рейтинга нет — наведите курсор на число, чтобы прочитать причину.',
        'rating.provisional': 'предварительная оценка: выборка мала',
        'rating.stale':
          'самому новому подходящему замеру больше 30 дней: это оценка по истории, а не по свежим данным',
        'rating.scoreTitle':
          '{score} из 100 по {qualified} подходящим замерам в {sessions} сессиях. Скорость и отклик этой пары в этой установке, а не качество ответов и не доступность сейчас.',
        'rating.noSamples': 'рейтинга нет: в истории нет ни одного замера этой пары',
        'rating.noQualified':
          'рейтинга нет: ни один замер не прошёл проверку спана, токенов и фрагментов',
        'rating.insufficient':
          'рейтинга нет: подходящих замеров {qualified}, эффективных {effective} — для публикации нужно не меньше 10 и того, и другого',
        'rating.pairOnly':
          'Рейтинг считается для пары провайдер–модель, а эта строка — провайдер целиком. Переключитесь на вид «по моделям».',
        'details.summary': 'Подробнее',
        'details.rating': 'рейтинг {version}: {score} из 100',
        'details.evidence':
          'подходящих замеров {qualified} из {answered} ответов; исключено: {retried} с повторами, {interrupted} прерванных (могут пересекаться); эффективных {effective}; сессий {sessions}',
        'details.anchor': 'вес падает вдвое за 30 дней; самый новый подходящий замер {ago}',
        'details.measurements':
          'взвешенные квантили, а не медианы столбцов: скорость {tps} tok/s, отклик {ttft}, отклик p90 {ttftP90}',
        'details.factors': 'множители: скорость {throughput}, отклик {latency}, хвост {tail}',
        'details.reference':
          'маршрут объявляет · контекст: {context} · лимит ответа по умолчанию: {outputCap} · вход: {modalities} · reasoning: {reasoning}',
        'details.reasoningDefault': '{efforts} — по умолчанию {defaultEffort}',
        'details.referenceSource': 'источник: адаптер DSH, спрошен {ago}',
        'details.referenceNone':
          'сведения о маршруте недоступны: DSH ничего не отдал об этой паре',
        'details.price': 'цена и квоты: {value}',
        'details.priceUnknown': 'неизвестны — DSH не отдаёт единых тарифных и квотных данных',
        'details.caution':
          'Измерения зависят от размера запросов, режима reasoning и сети. Отсутствие повторов не доказывает отсутствие сетевой задержки.',
        'details.unknown': 'не объявлено',
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
        // The legend is three halves, and only the third one depends on which
        // columns are open. `note.core` is the rule; the two marks the rating cell
        // prints are appended to it at render time out of the same keys the cell's
        // own tooltip uses (`markLegend`), because that cell is a compact column;
        // and `note.extra` or `note.collapsed` is what the expanded set adds or
        // hides. Nothing here names a column that may be behind the button — a
        // legend that describes a column the reader cannot see is the mistake
        // this file used to make, once with the marks and once with the scale
        // columns.
        'note.core':
          'Зелёным отмечены лучшие медианы, красным — худшие среди показанных строк. Значение «-» означает, что провайдер не записал тайминги потока для этой модели, а не что она медленная. Наведите курсор на заголовок столбца, чтобы прочитать, что он измеряет. Заголовок — кнопка сортировки: щёлкните, чтобы упорядочить строки по нему, ещё раз — чтобы развернуть порядок. Под столбцами, которые несут шкалу, нарисована полоска: доля значения от наибольшего в этом столбце. «рейтинг» — техническая оценка пары, 0–100; курсор на числе покажет, по скольким замерам он посчитан. ',
        'note.extra':
          '«замер» — доля шагов, где спана хватило для достоверной скорости: низкое значение значит, что модель в основном отдавала очень короткие порции, и tok/s по ней менее надёжен. «кэш» — доля чтения из кэша промпта во входных токенах. «виден» — когда модель последний раз отвечала. Под «Подробнее» под названием модели — из чего сложился рейтинг и что маршрут объявляет о себе: контекст, лимит ответа по умолчанию, вход и reasoning.',
        'note.collapsed':
          'Отклик p90, tok/s max, «замер», llm / шаг, «кэш», «виден» — за кнопкой «все метрики»; там же под названием модели появляется «Подробнее»: из чего сложился рейтинг и что маршрут объявляет о себе.',
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
        'hint.columns.all':
          'Shows every column, not just the core ones: response p90, tok/s max, “meas.”, llm / step, prefill, our overhead, cache, retries, “seen” and the rest. Press it again to go back to the short set. The choice is remembered and survives a page reload.',
        'models.open': 'Models',
        'models.count': '{selected} of {total}',
        'models.group': 'Model selection',
        'models.search': 'Search by provider or model',
        'models.selectAll': 'Select all',
        'models.selectNone': 'Clear all',
        'models.reset': 'Restore the default selection',
        'models.resetDefault': 'Restore the default selection',
        'models.empty': 'Nothing matches this search.',
        'models.providerCount': '{selected} of {total} models',
        'models.provider.measured':
          'The provider is ruled “measured only”: the models selected are the ones the history has run. A model run for the first time will not appear by itself.',
        'models.note': 'models selected: {selected} of {total}',
        'models.truncated': 'Showing {shown} of {total} selected rows.',
        'models.showAll': 'Show all',
        'models.painted': 'The first {shown} of {total} rows are drawn.',
        'models.paintMore': '{count} more rows',
        'models.storage':
          'The browser does not allow storing data: the selection lasts while this tab is open and will not survive closing it.',
        'models.unknownCatalog':
          'This installation’s catalog could not be read: the tree holds only what the history knows, and the archive is unmarked.',
        'empty.selection': 'No models selected.',
        'empty.selected':
          'The selected models have no measurements in the history: clear a tick or pick another model.',
        'announce.selection.reset': 'The model selection is back to the default.',
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
        'column.tools': 'tools/step',
        'column.toolTime': 'tool time/step',
        'column.lastSeen': 'seen',
        'column.liveness': 'status',
        'column.rating': 'rating',
        'probe.label': 'Check',
        'action.liveness.all': 'Check All',
        'action.liveness.selected': 'Check Selected',
        'action.liveness.provider': 'Check Provider',
        'hint.liveness.all':
          'Probes every configured model, including the ones checked less than five minutes ago. Each check is a real request to the model over the same route real work takes: one short request, and a green circle means the harness itself can reach the model. Pressing it while a check is running does nothing — wait for that one to finish.',
        'hint.liveness.selected':
          'Probes only the models ticked in the “Models” tree, and probes them again even if one was checked less than five minutes ago: the press asks for exactly those models right now. An empty selection disables the button, because there is nothing to check. One model is checked by its own circle in the “status” column.',
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
          'Error events per 100 steps, normalized for activity rather than a raw total. Not a failed-request percentage or a model-quality score: a step may have several errors, and task difficulty and causes differ. It is not a failed-request percentage or a model-quality score: one step can contain several errors, and causes include the model, provider and harness. The bar under the figure is its share of the largest value in the column, and it is grey on purpose: a rate alone blames neither the model nor the provider.',
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
        'hint.tools':
          'Tool calls per step of this model, counted over every step it took — so a step that called nothing is a measured zero rather than missing data, and models are compared whole rather than only over the steps that happened to need a tool. This is how much loop the work involves, not how good it is: more calls is not better. Only calls that came back are counted; a call with no result is in no figure of this column. A “-” means the model has no steps at all.',
        'hint.toolTime':
          'Median wall time one step of this model spent waiting for the tools it called, from `tool/call` to `tool/result`. It is the tool’s time and not the model’s: the sandbox running a command (bash, ~2.8 s a call on this history) and a person answering a question (ask_user_question, hundreds of seconds a call) are both in it, which is why the milliseconds alone say nothing about the model. The column is here to show what the agent loop spends between two model calls, and the per-tool breakdown travels with the row in the panel’s answer. Tool time is not part of our overhead or of the step’s own duration: the log closes the step at the model’s message and the tool answers after it. The median is over the steps that did call a tool, so a model whose steps need none shows “-” rather than 0 ms.',
        'hint.lastSeen': 'When the model last answered, across every session in the history.',
        'hint.rating':
          'Technical rating of this provider–model pair, 0–100. It weighs generation speed, typical response and slow response. All history, with a measurement’s weight halved every 30 days against the newest usable one. Retried and interrupted steps are excluded. It does not judge intelligence, availability, price or context size. A rating is published from 10 qualified measurements and marked “~” while the effective sample or the session count is small, and “*” when the newest usable measurement is over 30 days old: the score stays historical and is never recomputed from its age. “-” means there is no rating — hover the figure to read why.',
        'rating.provisional': 'provisional: the evidence is thin',
        'rating.stale':
          'the newest usable measurement is over 30 days old: this is a historical score, not a fresh reading',
        'rating.scoreTitle':
          '{score} of 100 over {qualified} qualified measurements in {sessions} sessions. This pair’s speed and response in this installation, not answer quality and not reachability right now.',
        'rating.noSamples': 'no rating: the history holds no measurement of this pair',
        'rating.noQualified':
          'no rating: no measurement passed the span, token and fragment gates',
        'rating.insufficient':
          'no rating: {qualified} qualified measurements, {effective} effective — 10 of each are needed to publish one',
        'rating.pairOnly':
          'A rating belongs to a provider–model pair, and this row is a whole provider. Switch to the model view.',
        'details.summary': 'Details',
        'details.rating': 'rating {version}: {score} of 100',
        'details.evidence':
          'qualified measurements {qualified} of {answered} answers; excluded: {retried} retried, {interrupted} interrupted (they may overlap); effective {effective}; sessions {sessions}',
        'details.anchor': 'weight halves every 30 days; newest usable measurement {ago}',
        'details.measurements':
          'weighted quantiles, not the column medians: speed {tps} tok/s, response {ttft}, response p90 {ttftP90}',
        'details.factors': 'multipliers: throughput {throughput}, response {latency}, tail {tail}',
        'details.reference':
          'the route declares · context: {context} · default output cap: {outputCap} · input: {modalities} · reasoning: {reasoning}',
        'details.reasoningDefault': '{efforts} — default {defaultEffort}',
        'details.referenceSource': 'source: DSH adapter, asked {ago}',
        'details.referenceNone': 'no route information: DSH returned nothing about this pair',
        'details.price': 'price and quotas: {value}',
        'details.priceUnknown': 'unknown — DSH exposes no unified tariff or quota data',
        'details.caution':
          'Measurements depend on request size, reasoning mode and the network. The absence of retries does not prove the absence of network latency.',
        'details.unknown': 'not declared',
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
          'Green marks the best medians, red the worst among the rows shown. A “-” means the provider recorded no stream timing for that model, not that the model is slow. Hover a column heading to read what it measures. A heading is a sort control: click it to order the rows by that column, click it again to reverse the order. Under the columns that carry a scale there is a bar: that value’s share of the largest one in the column. “rating” is the pair’s technical score, 0–100; hover the figure to read how many measurements stand behind it. ',
        'note.extra':
          '“meas.” is the share of steps whose span was long enough to be a reliable rate: a low value means the model mostly emitted very short bursts, so its tok/s is the least trustworthy number in the row. “cache” is the prompt-cache read share of input tokens. “seen” is when the model last answered. The “Details” block under the model name says what the rating is made of and what the route declares about itself — context, default output cap, input and reasoning.',
        'note.collapsed':
          'Response p90, tok/s max, “meas.”, llm / step, “cache”, “seen” — behind the “all metrics” button; there the model name also gains a “Details” block: what the rating is made of and what the route declares about itself.',
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

    // The largest page the panel will ask for, and the host's own bound on one
    // (`MAX_PANEL_ROWS` in `lib/collect.js`, which validates the request against
    // it). The two are the same number for the same reason: a page the host would
    // refuse is not a page, and a panel that asked for one would report a 400 as a
    // failure to answer.
    //
    // Raising the page is what the reader's "show all" does when the selection does
    // not fit on one page. It is bounded rather than unlimited on purpose — a
    // selection is a set the reader built, but a set is still a set, and an
    // unbounded page is an answer that cannot be sent.
    const MAX_ROWS = 2000

    // How many rows the panel is willing to put on the page, ever.
    //
    // Not a payload bound — that is `MAX_ROWS` above — but a rendering one, and the
    // two are different numbers for a measured reason. Measured in this tree: a row
    // of the expanded set is 21 cells and ~55 element nodes, so the default page of
    // 200 rows is ~11 200 nodes and takes 59 ms to build, while the 2000 rows «Показать
    // все» may ask for are ~110 200 nodes and 302 ms before the browser has styled
    // anything (Chromium then needs ~220 ms of layout and ~107 ms of paint for a
    // 2000×21 table of the same shape). `content-visibility: auto` was measured as
    // the alternative and is not one: on the rows it buys ~2% of that layout and ~9%
    // of the paint, on the cells it collapses every row to its intrinsic height
    // (scrollHeight 61 421 -> 29 031, so the scrollbar lies), and on the body it does
    // nothing, because the body always intersects the viewport.
    //
    // So the bound is on rows drawn rather than on rows sent, and it is the reader's
    // own `PAGE_ROWS`: a page is what the table is for, the answer still carries the
    // whole selection, and "show more" appends the next page to the same table. Every
    // row stays a real row — no windowing, so the pinned column, the keyboard, the
    // screen-reader associations and the browser's own find-in-page keep working — and
    // the DOM is bounded by what the reader has asked to see rather than by what the
    // host had to fold.
    const RENDER_ROWS = PAGE_ROWS

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
    //
    // Each version answers a question the previous one could not be asked. v2
    // dropped the v1 entries because their keys named a provider filter and every
    // one of them would have been a miss anyway. v3 drops the v2 entries because a
    // payload written by a build that predates the rating column is a full answer
    // about the same pairs with no rating in any row: the reader would open a table
    // of dashes in a column every other install fills, and no field of that payload
    // says which build wrote it. The version is the only place that can be said.
    // Starting empty rather than keeping the dead entries costs nothing either: the
    // store holds four, so they would be evicted by the first clicks anyway. The
    // preference key is deliberately *not* bumped with it: which models the reader
    // picked is their decision and outlives every one of these rewrites.
    const STORE_KEY = 'dsh-model-scorecard:v3'
    const STORE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
    const REFRESH_INTERVAL_MS = 1500
    const MAX_REFRESHES = 20

    /**
     * The identity of one query: `sort.dir|view|selection|archive|page`.
     *
     * It names a cache entry and it labels the rows a payload answers. The panel
     * needs the second job because a switch to another sort — or to another set of
     * selected models — has no answer yet, and what is on screen in the meantime
     * belongs to a query the user is no longer asking for. The direction is part of
     * the identity and not a detail of it: the same key in the other direction is a
     * different table, and answering it from a cache entry that was stored the other
     * way round would show rows in an order nobody asked for, under an arrow
     * claiming that order.
     *
     * The selection part is the canonical rule document, so two clicks that leave
     * the rules saying the same thing are one cache entry — and the archive part is
     * absent while the archive is off, so the default question keeps the key it had
     * before the archive existed. A payload cached by a build that predates the
     * selection is not a hit under any key: its rows answer a question about every
     * measured model, which is not what the panel asks now.
     *
     * The last part is the page the reader raised. «Показать все» is a different
     * question, not a larger answer to this one, and a key that cannot tell the two
     * apart stores the first under the second: a later open paints two thousand rows
     * as the answer to a two-hundred-row question, and the refresh behind it takes
     * them away again with nothing to explain the difference. The part is absent
     * unless the page was raised, so the ordinary question keeps the key it always
     * had — the store is versioned by shape, not by question.
     */
    function queryKey(sort, dir, view, selection, archived, whole = false) {
      const base = `${sort}.${dir}|${view}|${JSON.stringify(canonicalSelectionRules(selection))}`
      const named = archived === true ? `${base}|archive` : base
      return whole === true ? `${named}|all` : named
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

    function readCachedPayload(sort, dir, view, selection, archived, whole = false) {
      const entry = readCache()[queryKey(sort, dir, view, selection, archived, whole)]
      if (entry === null || typeof entry !== 'object') return null
      if (typeof entry.at !== 'number' || Date.now() - entry.at > STORE_MAX_AGE_MS) return null
      const data = entry.data
      if (data === null || typeof data !== 'object' || data.ok !== true) return null
      if (!Array.isArray(data.rows)) return null
      return data
    }

    /**
     * What the browser may be asked to keep.
     *
     * A number of bytes rather than a number of keys, because the entries are not the
     * same size and stopped being the same size: this panel's own answer measures 183
     * KB for 141 rows, so a row is ~1.3 KB, and the page the reader can raise to 2000
     * makes one entry ~2.5 MB where the default page makes ~260 KB. "Four keys" was
     * chosen when an entry was ~60 KB and says nothing about either of those; against
     * a 5 MB origin quota shared with the rest of the GUI, four large answers are
     * the whole of it and one of them would have failed the write on its own.
     *
     * The budget is deliberately under the quota rather than at it: this store is one
     * of several on the same origin, and the panel's own failure mode for a full one
     * is already benign — the write is swallowed, the entry is simply not there next
     * time, and the reader waits for a request instead of painting from a cache.
     */
    const CACHE_BUDGET_BYTES = 2 * 1024 * 1024

    /**
     * The last answer is kept, and only the last answer for that question.
     *
     * Walking newest-first from the budget's point of view rather than the oldest
     * first: what is dropped is whatever does not fit behind what the reader just
     * asked for, so a single entry larger than the whole budget — the 2000-row answer
     * is — is not stored at all. That is the intended outcome and not an accident of
     * the arithmetic: an answer too big to keep is asked for again, and the panel is
     * built to render without one.
     */
    function writeCachedPayload(sort, dir, view, selection, archived, whole, data) {
      try {
        const entries = readCache()
        entries[queryKey(sort, dir, view, selection, archived, whole)] = { at: Date.now(), data }
        const keys = Object.keys(entries).sort((a, b) => (entries[a]?.at ?? 0) - (entries[b]?.at ?? 0))
        let bytes = 0
        for (let index = keys.length - 1; index >= 0; index -= 1) {
          const key = keys[index]
          const size = JSON.stringify(entries[key]).length
          // What is dropped does not spend the budget. An entry that did not fit is
          // gone, and counting it anyway would push the next one out behind it — a
          // single 2000-row answer would then empty the store rather than only
          // cost itself a place in it.
          if (bytes + size > CACHE_BUDGET_BYTES) delete entries[key]
          else bytes += size
        }
        window.localStorage.setItem(STORE_KEY, JSON.stringify({ entries }))
      } catch {
        // A full or disabled store is not the panel's problem.
      }
    }

    // --- the selection ------------------------------------------------------------
    //
    // Which models the table is about, kept as a *rule* and not as a list of pairs.
    //
    // The difference matters in one direction, and it is the direction a reader
    // notices: a rule survives the catalog changing under it. Under "all of this
    // provider" a model the configuration gained overnight appears in the next
    // answer, while a list of names captured yesterday would not name it and would
    // leave it out of a provider the reader had marked as complete. So what travels
    // to the host is the rule document below, and what the host does with it is
    // resolve it against the catalog only the host can see in full.
    //
    // The panel resolves the same rules locally, against the catalog the last
    // answer carried, for the one job the host cannot do for it: drawing the tree.
    // A checkbox has to be drawn before the next answer arrives, and it is drawn
    // from the same three-step precedence the host applies — an explicit pair, then
    // the provider's rule, then the scope's base — because a tree that disagreed
    // with the table under it would be worse than no tree at all.
    //
    // Two scopes, because the archive is one: a model outside the configuration is a
    // different item from one inside it, and a reader's marks about each are kept
    // apart. While the archive is off its scope is not applied but is still stored,
    // so switching the archive on brings the marks back instead of resetting them.
    const SELECTION_SCOPES = ['live', 'archive']
    const SELECTION_BASES = ['measured', 'all', 'none']
    // What one provider may be ruled as. The third value is a state of a click and
    // not a fourth end: `measured` is where a group falls to from "nothing selected",
    // and a group whose every model has been run resolves it to `all` — so its cycle
    // has the two states the reader can tell apart, not three.
    const SELECTION_PROVIDER_RULES = ['all', 'measured', 'none']
    // The same bounds the route enforces, duplicated here the way the sort
    // directions are: the panel has to be able to refuse a corrupt store before it
    // sends it, and the host still checks what it receives. They are past any real
    // catalog — the measured one is 137 pairs over 16 providers — so a store beyond
    // them is corruption rather than a large install.
    const MAX_SELECTION_PROVIDERS = 512
    const MAX_SELECTION_PAIRS = 2048

    function defaultSelectionRules() {
      return {
        live: { base: 'measured', providers: {}, pairs: {} },
        archive: { base: 'none', providers: {}, pairs: {} },
      }
    }

    /** `provider\u0000model`, the key one pair is identified by on both sides. */
    function pairKeyOf(provider, model) {
      return `${provider}\u0000${model}`
    }

    /**
     * A resolved selection back as `{ provider, model }` pairs, for the one request
     * that names models instead of asking for the catalog.
     *
     * The set is sorted so that the same selection always produces the same body:
     * it is the request that decides which probes a sweep runs, and an order that
     * moved between two presses of the same button would be an order nobody chose.
     */
    function pairsOf(pairs) {
      return [...pairs]
        .sort()
        .map((key) => {
          const cut = key.indexOf('\u0000')
          if (cut === -1) return null
          return { provider: key.slice(0, cut), model: key.slice(cut + 1) }
        })
        .filter((pair) => pair !== null)
    }

    /**
     * The rules in one canonical spelling: sorted keys, one document per meaning.
     *
     * It is what the payload cache is keyed by, so two documents that mean the same
     * thing must produce one key; and it is what the host echoes back, so a panel
     * can tell an answer to the question it asked from an answer to another one.
     */
    function canonicalSelectionRules(rules) {
      const source = rules !== null && typeof rules === 'object' ? rules : {}
      const defaults = defaultSelectionRules()
      const out = {}
      for (const scope of SELECTION_SCOPES) {
        const value = source[scope]
        const entry = value !== null && typeof value === 'object' ? value : {}
        const providers = {}
        for (const name of Object.keys(entry.providers ?? {}).sort()) providers[name] = entry.providers[name]
        const pairs = {}
        for (const key of Object.keys(entry.pairs ?? {}).sort()) pairs[key] = entry.pairs[key]
        out[scope] = {
          base: SELECTION_BASES.includes(entry.base) ? entry.base : defaults[scope].base,
          providers,
          pairs,
        }
      }
      return out
    }

    /**
     * One scope of a stored or written rule document, typed, bounded and honest
     * about having been bounded.
     *
     * The stop at the bound is a stop on *reading* and not a silent trim: `overflow`
     * says the document held more than this panel is willing to read, and the caller
     * then resets the scope rather than keeping an arbitrary prefix of it. Keeping the
     * first thousand pairs and dropping the rest would answer a question about a set
     * the reader never chose, with nothing on screen saying so — which is the one
     * thing this panel must not do with a selection. The host refuses such a document
     * outright (`normalizeSelectionRules` in `lib/collect.js` answers an error, and
     * the route a 400), so a document this size never came from this panel.
     */
    function selectionScopeOf(value, fallbackBase) {
      const scope = {
        base: SELECTION_BASES.includes(value?.base) ? value.base : fallbackBase,
        providers: {},
        pairs: {},
      }
      let overflow = false
      const providers = value?.providers
      if (providers !== null && typeof providers === 'object' && !Array.isArray(providers)) {
        for (const [name, rule] of Object.entries(providers)) {
          if (!SELECTION_PROVIDER_RULES.includes(rule)) continue
          if (name === '') continue
          if (Object.keys(scope.providers).length >= MAX_SELECTION_PROVIDERS) {
            overflow = true
            break
          }
          scope.providers[name] = rule
        }
      }
      const pairs = value?.pairs
      if (pairs !== null && typeof pairs === 'object' && !Array.isArray(pairs)) {
        for (const [key, rule] of Object.entries(pairs)) {
          if (rule !== 'on' && rule !== 'off') continue
          if (key === '' || key.indexOf('\u0000') <= 0) continue
          if (Object.keys(scope.pairs).length >= MAX_SELECTION_PAIRS) {
            overflow = true
            break
          }
          scope.pairs[key] = rule
        }
      }
      return { scope, overflow }
    }

    /**
     * The rules the tree is drawn from, out of whatever the browser kept.
     *
     * A scope that was over its bound, or too large to read whole, is reset to its
     * default rather than cut down to whatever fit: this panel would rather open on
     * the rule a first visit uses than on a prefix of a set the reader chose and
     * cannot see. The tree then shows what it did, and the reader's marks are one
     * click away from being rebuilt.
     */
    function normalizeSelectionRules(value) {
      const source = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
      const defaults = defaultSelectionRules()
      const rules = {}
      for (const scope of SELECTION_SCOPES) {
        const read = selectionScopeOf(source?.[scope], defaults[scope].base)
        rules[scope] = read.overflow ? defaults[scope] : read.scope
      }
      return rules
    }

    /**
     * The rules as the pairs they select, over one catalog.
     *
     * The precedence lives here, once, and its result is used for both jobs the
     * panel has: drawing the tree, and counting what a provider's checkbox says.
     * The host applies the same rule to the same catalog, and
     * `tools/verify-selection.mjs` pins the two against each other.
     */
    function resolveSelection(rules, catalog) {
      const scopeOf = (name, fallback) => {
        const value = rules?.[name]
        if (value === null || typeof value !== 'object') return null
        return {
          base: SELECTION_BASES.includes(value.base) ? value.base : fallback,
          providers: value.providers ?? {},
          pairs: value.pairs ?? {},
        }
      }
      const live = scopeOf('live', 'measured')
      const archive = scopeOf('archive', 'none')
      const selected = new Set()
      const providers = []
      for (const group of Array.isArray(catalog) ? catalog : []) {
        const models = Array.isArray(group?.models) ? group.models : []
        let count = 0
        for (const entry of models) {
          const rule = entry.archived === true ? archive : live
          let on
          if (rule === null) {
            on = entry.archived !== true && entry.noStats !== true
          } else {
            const exception = rule.pairs[pairKeyOf(group.provider, entry.model)]
            if (exception === 'on') on = true
            else if (exception === 'off') on = false
            else {
              const provider = rule.providers[group.provider]
              if (provider === 'all') on = true
              else if (provider === 'none') on = false
              else if (provider === 'measured') on = entry.noStats !== true
              else if (rule.base === 'all') on = true
              else if (rule.base === 'none') on = false
              else on = entry.noStats !== true
            }
          }
          if (!on) continue
          selected.add(pairKeyOf(group.provider, entry.model))
          count += 1
        }
        providers.push({ provider: group.provider, selected: count, total: models.length })
      }
      return { pairs: selected, providers }
    }

    /** Whether two rule documents say the same thing, for the reset control. */
    function sameSelectionRules(a, b) {
      return JSON.stringify(canonicalSelectionRules(a)) === JSON.stringify(canonicalSelectionRules(b))
    }

    /**
     * What the rules say about one pair when the reader has never touched it: the
     * provider's rule, then the scope's base.
     *
     * Read by resolving the document with this pair's own exception removed, and
     * that is not indirection for its own sake: under the `measured` base the answer
     * is "the history has a step for it", which only the catalog knows. An
     * individual click is then written down only when the reader's wish differs from
     * this — so unticking one model under "all of this provider" stores one
     * exception, while unticking it under "nothing selected" stores nothing at all.
     */
    function inheritedPairState(rules, scope, provider, model, catalog) {
      const probe = canonicalSelectionRules(rules)
      delete probe[scope].pairs[pairKeyOf(provider, model)]
      return resolveSelection(probe, catalog).pairs.has(pairKeyOf(provider, model))
    }

    /** One model's checkbox as a rule change. */
    function rulesWithPair(rules, scope, provider, model, on, inherited) {
      const next = canonicalSelectionRules(rules)
      const key = pairKeyOf(provider, model)
      if (inherited === on) delete next[scope].pairs[key]
      else next[scope].pairs[key] = on ? 'on' : 'off'
      return next
    }

    /**
     * What one click on a provider asks for, out of where the group stands.
     *
     * A full group clears, a group the reader cleared comes back as its measured
     * models, and anything else goes to all — the three steps of one cycle, and the
     * step a partly selected group takes is the first: "all except the ones I
     * excluded" is not a state a parent checkbox can offer.
     *
     * The rule is read as well as the counts, and the reason is the one place the
     * two statements overlap: a group at "nothing selected" is both "not all
     * selected" and "cleared", and only the rule says which of the two the reader
     * last asked for. It is the cleared one that goes to the measured part, so a
     * group nobody has touched opens on "all" while a group the reader emptied comes
     * back with the models that have a step behind them.
     *
     * `measured` is a rule and not a list of the pairs that have a step, so a model
     * the provider gains and that is run for the first time joins it — see
     * `rulesWithProvider`. A group whose every model has been run resolves that rule
     * to `all`, and there the cycle is honestly two states: there is nothing to tell
     * "everything" from "everything measured" about.
     */
    function nextProviderRule(rule, counts) {
      if (counts.total > 0 && counts.selected === counts.total) return 'none'
      return rule === 'none' ? 'measured' : 'all'
    }

    /**
     * One provider's checkbox as a rule change.
     *
     * It clears the provider's own exceptions, and the reason is what the click
     * means: "all of this provider" and "none of it" are decisions about the whole
     * group, and an exception left behind would make the checkbox say one thing
     * while a model under it said another — the reader would have to click twice to
     * get what one click asked for. The same goes for "only the measured ones": it
     * is a statement about the provider, and the pairs it leaves out are the ones it
     * left out by rule. A rule about the provider is also what makes it stay a
     * decision: a model it gains later follows it.
     */
    function rulesWithProvider(rules, scope, provider, rule) {
      const next = canonicalSelectionRules(rules)
      for (const key of Object.keys(next[scope].pairs)) {
        if (key.slice(0, Math.max(0, key.indexOf('\u0000'))) === provider) delete next[scope].pairs[key]
      }
      next[scope].providers[provider] = rule
      return next
    }

    /**
     * The scopes one provider's group spans, and the rule it stands on.
     *
     * A group is drawn as one row with one count, and its checkbox is one click
     * about one provider — so the click has to reach every model in the group. That
     * is only true while every model belongs to the same scope. A provider that kept
     * a model and retired another has models in both, and a rule written into one of
     * them changed fewer rows than the checkbox promised: the other half kept
     * whatever its own scope said, and the next click started its cycle from a rule
     * the reader had not just set.
     *
     * So the group spans every scope its models are in — the same shape
     * `rulesForAll` gives the global buttons, for the same reason: the two scopes
     * are two halves of one decision about a provider, and a decision about half a
     * provider is not what the reader clicked.
     *
     * The standing rule is read across the same scopes, and the order is not
     * arbitrary: a group the reader cleared stays cleared even when only one half
     * carries the `none`, because the next state of a cleared group is its measured
     * models rather than a fresh "all"; and `measured` outranks an absent rule,
     * because it is the one state the marks cannot express and a group that
     * declared it on either half has it.
     *
     * The archive being off is not a case here: `selectionCatalog` leaves archived
     * models out of the tree until the archive is on, so a group the reader can see
     * while it is off is a live group and spans `live` alone.
     */
    function providerGroupScopes(group, rules) {
      const hasArchived = group.models.some((entry) => entry.archived === true)
      const hasLive = group.models.some((entry) => entry.archived !== true)
      const scopes = hasArchived && hasLive ? SELECTION_SCOPES : hasArchived ? ['archive'] : ['live']
      const standing = scopes
        .map((scope) => rules?.[scope]?.providers?.[group.provider])
        .filter((value) => value !== undefined)
      const rule = standing.includes('none')
        ? 'none'
        : standing.includes('measured')
          ? 'measured'
          : (standing[0] ?? null)
      return { scopes, rule }
    }

    /**
     * The global buttons: every item available under the current archive state.
     *
     * The archive being off is not a reason to write marks into a scope nobody can
     * see — turning the archive on must bring back the reader's own marks and not a
     * decision this button made on their behalf about models they were never shown.
     * So the archive scope is rewritten only while the archive is on screen.
     */
    function rulesForAll(rules, base, archived) {
      const next = canonicalSelectionRules(rules)
      for (const scope of archived === true ? SELECTION_SCOPES : ['live']) {
        next[scope].base = base
        next[scope].providers = {}
        next[scope].pairs = {}
      }
      return next
    }

    /**
     * The body one panel question is asked with.
     *
     * A function of its own because two halves have to agree about it: this panel
     * builds it and the host validates it (`queryFromBody` in `lib/index.js`), and a
     * field that drifted — a renamed key, a limit past the host's own ceiling, a
     * `view` spelling — would come back as a 400 the reader would read as the panel
     * being broken. `tools/verify-selection.mjs` feeds this function's output to the
     * host's own validator, so the two are checked against each other rather than
     * against a hand-written copy of the schema.
     */
    function panelQueryBody({ sort, dir, view, archived, selection, wholeSelection }) {
      return {
        sort,
        dir,
        view,
        archived: archived === true,
        limit: wholeSelection === true ? MAX_ROWS : PAGE_ROWS,
        selection: canonicalSelectionRules(selection),
      }
    }

    // How the panel is set up is the user's choice, not a cache: it lives in its
    // own key so that dropping the payload cache can never drop the preferences.
    //
    // The key is versioned because the shape changed. v1 kept a flat list of
    // provider names, which is not a rule and cannot say "everything of this
    // provider except one model". The version lives in the key rather than in a
    // field checked at read time, so each half reads exactly the documents it
    // wrote and never has to guess at an older shape.
    const PREFS_KEY = 'dsh-model-scorecard:prefs:v2.selection'
    const LEGACY_PREFS_KEY = 'dsh-model-scorecard:prefs:v1'

    /** One JSON document out of the store, or null. Never throws. */
    function readStoredJson(key) {
      try {
        const raw = window.localStorage.getItem(key)
        if (raw === null) return null
        const parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' ? parsed : null
      } catch {
        return null
      }
    }

    // A store the browser refuses is not a reason to lose the panel: this tab keeps
    // its state in memory and says so, rather than pretending a choice was written
    // down for the next visit.
    let memoryPrefs = null
    let storageProbe = null

    function storageAvailable() {
      if (storageProbe === null) {
        try {
          const probe = 'dsh-model-scorecard:probe'
          window.localStorage.setItem(probe, '1')
          window.localStorage.removeItem(probe)
          storageProbe = true
        } catch {
          storageProbe = false
        }
      }
      return storageProbe
    }

    /**
     * The preference document: the display settings and the selection rules.
     *
     * A v1 store is migrated once, explicitly, and the old key is left where it is.
     * The provider filter it holds is a real choice the reader made, and dropping it
     * would open their panel on a different set of models than the one they left.
     * Its names become "all of this provider" rules under the default base, which is
     * the same set of rows that filter showed — and an *empty* list keeps meaning
     * "no filter", never "nothing selected": reading it as an empty selection is
     * exactly how a first open would come up blank for everyone who never touched
     * the control.
     */
    function readPrefs() {
      const stored = readStoredPrefs()
      if (stored !== null) return stored
      const legacy = readLegacyV1()
      const selection = defaultSelectionRules()
      for (const name of normalizeProviders(legacy?.providers)) selection.live.providers[name] = 'all'
      const migrated = {
        version: 2,
        sort: Object.prototype.hasOwnProperty.call(SORT_DIRS, legacy?.sort) ? legacy.sort : null,
        dir: legacy?.dir === 'asc' || legacy?.dir === 'desc' ? legacy.dir : null,
        view: legacy?.view === 'provider' ? 'provider' : null,
        archived: legacy?.archived === true,
        columnsAll: legacy?.columnsAll === true,
        selection,
      }
      // Written down only when there was something to migrate: a default document
      // on disk would make the next read look like a stored choice. The write is
      // the raw one, not `writePrefs` — a writer that merged over `readPrefs()`
      // would re-enter the migration that is still deciding what to write.
      if (legacy !== null) storePrefs(migrated)
      return migrated
    }

    /** The v2 document, from the current key or from memory, or null. */
    function readStoredPrefs() {
      if (!storageAvailable()) return normalizePrefs(memoryPrefs)
      return normalizePrefs(readStoredJson(PREFS_KEY))
    }

    /**
     * The v1 document, or null.
     *
     * A separate read from `readStoredPrefs` because the two questions are
     * different ones: `readStoredPrefs` asks what the panel is set up as now,
     * this one asks whether an older shape is waiting to be read up. Both keys
     * are under the current name — the namespace was never part of the version.
     */
    function readLegacyV1() {
      if (!storageAvailable()) return null
      return readStoredJson(LEGACY_PREFS_KEY)
    }

    /** A stored document, whatever name it was stored under, as this panel reads it. */
    function normalizePrefs(stored) {
      if (stored === null || stored === undefined || stored.version !== 2) return null
      return {
        version: 2,
        sort: Object.prototype.hasOwnProperty.call(SORT_DIRS, stored.sort) ? stored.sort : null,
        dir: stored.dir === 'asc' || stored.dir === 'desc' ? stored.dir : null,
        view: stored.view === 'provider' ? 'provider' : null,
        archived: stored.archived === true,
        columnsAll: stored.columnsAll === true,
        selection: normalizeSelectionRules(stored.selection),
      }
    }

    /** The document, written where the panel will find it next time. Never reads. */
    function storePrefs(document) {
      if (!storageAvailable()) {
        memoryPrefs = document
        return
      }
      try {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify(document))
      } catch {
        // A full store is not the panel's problem; the choice lives on in this tab.
        memoryPrefs = document
      }
    }

    /**
     * One change to the preference document.
     *
     * The base is what is *stored*, not what a read would produce: merging over a
     * read is how this function would re-enter the migration above and never
     * return. A store that has nothing yet is a store whose defaults are the base,
     * which is the same document the panel opened with.
     */
    function writePrefs(patch) {
      const base = readStoredPrefs() ?? readPrefs()
      storePrefs({ ...base, ...patch, version: 2 })
    }

    /**
     * The provider selection, as a list of exact names.
     *
     * Order is not part of the question — `a,b` and `b,a` are the same filter — so
     * the list is sorted, de-duplicated and bounded. A value that is not a name at
     * all (a number, a nested array, a 200-entry list from a corrupted store) is
     * dropped rather than sent: the host answers a filter it cannot match with the
     * whole table, which is the one result a filter must never produce silently.
     *
     * Only the v1 migration reads this now: the panel keeps rules.
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

    /**
     * The question the panel opens with: the last choice this browser kept, and the
     * defaults for everything it never chose.
     *
     * The address used to carry the question too, under `ms*` keys. It no longer
     * does, and not because a link is worthless: a selection is a rule document,
     * which cannot be spelled in a query string without either truncating it or
     * putting a reader's model names somewhere the host's page can read them. The
     * sort, the view and the archive went with it, so that one surface has one place
     * to remember what it asked — and the address keeps every key that is not ours,
     * exactly as it found them.
     */
    function readInitialQuery() {
      const prefs = readPrefs()
      const sort = prefs.sort ?? DEFAULT_QUERY.sort
      return {
        sort,
        dir: prefs.dir ?? SORT_DIRS[sort] ?? DEFAULT_QUERY.dir,
        view: prefs.view ?? DEFAULT_QUERY.view,
        archived: prefs.archived === true,
        selection: prefs.selection,
        columnsAll: prefs.columnsAll === true,
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
            // A provider row is a roll-up of the models the reader chose, so it has
            // to say how much of the provider it stands for: "3 of 4 models" is the
            // difference between a provider that is slow and one whose slowest model
            // was left out of the question.
            ctx.view === 'provider' && ctx.coverage?.has(row.provider)
              ? h(
                  'span',
                  { className: 'dsh-ms-coverage' },
                  ctx.t('models.providerCount', {
                    selected: ctx.fmt.count(ctx.coverage.get(row.provider).selected),
                    total: ctx.fmt.count(ctx.coverage.get(row.provider).total),
                  }),
                )
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
            // The one disclosure in the table: what the row's rating is made of
            // and what the route declares about itself. Drawn only in the expanded
            // column set — the compact table is one line per row, and a disclosure
            // under every name would spend that line on rows the reader has not
            // asked about. The legend says where it is, and `routeDetails` is the
            // native `<details>` a keyboard can open without a mouse.
            ctx.showDetails === true ? routeDetails(row, ctx) : null,
          )
        },
      },
      // The status column stands second, next to the name it belongs to. It is
      // the one column that is always shown, and the one cell a reader acts on —
      // so it sits where the eye starts rather than off the end of a wide table,
      // behind the one part of the table nobody scrolls to.
      {
        key: 'liveness',
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
      // The compact set's one figure that is a verdict rather than a reading, so
      // it sits next to the status: those two are the whole answer to "which of
      // these should I use", and everything else in the row is the evidence.
      {
        key: 'rating',
        base: 'num',
        // The rating and `ош./100` are the compact set's verdict and its evidence for
        // the one thing that matters most here — does the route finish what it
        // starts — and both earn the line they are on. The rating was once paid
        // for out of the error rate (see `CORE_COLUMNS`), which was a way of
        // making the reader choose between them; the table had room for both.
        sort: 'rating',
        labelKey: 'column.rating',
        hintKey: 'hint.rating',
        // One decimal and no bar. A bar is a share of the largest value in the
        // column, and the rating is the one figure on this table that is already
        // 0-100 on its own scale — drawing it against the best row on screen
        // would say "this is the best of five", which is not what the number says.
        //
        // No tone either: green and red in this panel mean "the best and worst
        // value in the table", and a rating may not be graded by the company it
        // keeps. The number is read on its own.
        cell: (row, ctx) => {
          // Through the shared formatter, never `.toFixed`: a payload from a host
          // that predates this column has no `rating` at all, and a raw
          // `undefined.toFixed` takes the whole panel down.
          const rating = row.rating
          const score = rating?.score
          const published = finite(score)
          const figure = ctx.fmt.num(score, 1)
          const marks = published ? ratingMarks(rating) : []
          const note = published
            ? ctx.t('rating.scoreTitle', {
                score: figure,
                qualified: ctx.fmt.count(rating.qualifiedSamples),
                sessions: ctx.fmt.count(rating.sessions),
              })
            : ratingReason(row, ctx)
          // The tooltip and the hidden text are one sentence on purpose: a `-`
          // has four different reasons, and a reader who cannot hover is the one
          // who most needs to be told which of them this is. The marks are part
          // of it, so the glyphs cannot be read without their sentences.
          const label = [note, ...marks.map((mark) => ctx.t(mark.text))].join(' · ')
          return h(
            'span',
            { className: 'dsh-ms-val', title: label },
            // A published score on thin evidence, or one whose evidence has all
            // aged out, says so in the cell and not only in the tooltip. `~` is
            // the same mark the agent's text report leads with for the same score,
            // so the two surfaces cannot describe one number two ways.
            //
            // The mark leads the figure rather than trailing it, and this is the
            // one arrangement that keeps the column readable: every cell here is
            // right-aligned (see `dsh-ms-num`), so a glyph appended after the
            // number pushes exactly that row's digits one glyph to the left of the
            // column every unmarked row is read in. Leading, the figure ends on
            // the cell's right edge on every row, whether it carries a mark or not.
            ...marks.map((mark) =>
              h(
                'span',
                { key: mark.key, className: 'dsh-ms-rating-thin', 'aria-hidden': 'true' },
                mark.glyph,
              ),
            ),
            figure,
            h('span', { className: 'dsh-ms-sr-only' }, ` — ${label}`),
          )
        },
      },
      {
        key: 'steps',
        base: 'num',
        sort: 'steps',
        labelKey: 'column.steps',
        hintKey: 'hint.steps',
        cell: (row, ctx) => ctx.fmt.count(row.steps),
      },
      {
        key: 'ttft',
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
        base: 'num',
        sort: 'errorRate',
        labelKey: 'column.errorRate',
        hintKey: 'hint.errorRate',
        // Through the shared formatter rather than `.toFixed` on the raw value:
        // a payload from a host that predates this column has no `errorRate` at
        // all, and `undefined.toFixed` takes the whole panel down.
        //
        // The bar makes the column a scale rather than a rate to divide in one's
        // head: the same column here reads 0,0 next to 20,1 with nothing between
        // them, which is two different stories about how often a model fails and
        // the fastest way to see which is which. It is neutral ink rather than a
        // verdict — unlike `ош.`, this figure is normalized, so a high bar is not
        // by itself a fault to point at.
        cell: (row, ctx) =>
          h(
            'span',
            { className: 'dsh-ms-val' },
            ctx.fmt.num(row.errorRate, 1),
            measurementScale(ctx, 'errorRate', row.errorRate),
          ),
      },
      {
        key: 'modelErrors',
        base: 'num',
        sort: 'modelErrors',
        labelKey: 'column.modelErrors',
        hintKey: 'hint.modelErrors',
        cell: (row, ctx) => ctx.fmt.count(row.modelErrors ?? 0),
        tone: (row) => (row.modelErrors > 0 ? 'dsh-ms-bad' : null),
      },
      {
        key: 'interrupted',
        base: 'num',
        sort: 'interrupted',
        labelKey: 'column.interrupted',
        hintKey: 'hint.interrupted',
        cell: (row, ctx) => ctx.fmt.count(row.interrupted ?? 0),
        tone: (row) => (row.interrupted > 0 ? 'dsh-ms-warn' : null),
      },
      {
        key: 'ttftP90',
        sort: 'ttftP90',
        labelKey: 'column.ttftP90',
        hintKey: 'hint.ttftP90',
        cell: (row, ctx) => ctx.fmt.ms(row.ttftP90),
      },
      {
        key: 'tpsMax',
        sort: 'tpsMax',
        labelKey: 'column.tpsMax',
        hintKey: 'hint.tpsMax',
        cell: (row, ctx) => ctx.fmt.num(row.tpsMax, 1),
      },
      {
        key: 'confidence',
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
        sort: 'llm',
        labelKey: 'column.llm',
        hintKey: 'hint.llm',
        cell: (row, ctx) => ctx.fmt.ms(row.llmMeanMs),
      },
      {
        key: 'cache',
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
          )
        },
      },
      // The only column whose fix is on this side: everything in it is time the
      // harness spent between the last delta and the closing message.
      {
        key: 'overhead',
        base: 'num',
        sort: 'overhead',
        labelKey: 'column.overhead',
        hintKey: 'hint.overhead',
        cell: (row, ctx) => ctx.fmt.ms(row.overheadMsMedian),
        tone: (row) => (row.overheadMsMedian !== null && row.overheadMsMedian >= 200 ? 'dsh-ms-warn' : null),
      },
      // The two tool columns are the last piece of the decomposition, and the
      // only one that is not about the model's own speed: `tools` counts what a
      // step reached for, `toolTime` is what that cost in wall time between two
      // model calls. They sit apart from `overhead` in the group order because
      // `overhead` is the harness and these are the loop — the same shape of
      // question, three different owners of the milliseconds.
      {
        key: 'tools',
        base: 'num',
        sort: 'tools',
        labelKey: 'column.tools',
        hintKey: 'hint.tools',
        cell: (row, ctx) => ctx.fmt.num(row.toolCallsPerStep, 2),
      },
      {
        key: 'toolTime',
        base: 'num',
        sort: 'toolTime',
        labelKey: 'column.toolTime',
        hintKey: 'hint.toolTime',
        cell: (row, ctx) => ctx.fmt.ms(row.toolMsMedian),
      },
      // The panel can sort by recency, so the timestamp it sorts by is a column
      // of its own instead of an invisible key.
      {
        key: 'lastSeen',
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
      ['name', 'liveness', 'rating'],
      ['steps', 'lastSeen'],
      ['ttft', 'ttftP90', 'ttftClean', 'retry'],
      ['e2e', 'tps', 'tpsMax', 'confidence'],
      ['errorRate', 'modelErrors', 'errors', 'interrupted'],
      ['llm', 'prefill', 'overhead', 'cache'],
      ['tools', 'toolTime'],
    ]
    // The compact set: identity, the two columns a reader acts on, and the four
    // figures a decision is made from. It is seven columns wide — it was six
    // while the rating was bought with `ош./100`, and the reader's own verdict on
    // that trade was that the column had come back: a table that fits does not
    // owe the reader a narrower one. Every other column is one click away behind
    // "all metrics", including the counts that go with this rate.
    //
    // This set is the *only* declaration of what is compact. The definitions above
    // carry no `tier` of their own, and the table's `tier` is derived from here in
    // the one place below, because the alternative was tried and read wrong: 19
    // per-column `tier` values used to sit in those definitions, nothing read them
    // (the render filter reads the derived copy), and four of them contradicted
    // this set — `liveness` and `e2e` said `extra` while they are compact, `tps`
    // and `errors` said `core` while they are not. The rendered table was right and
    // the list was wrong, which is the worst shape for a list a reader treats as
    // the specification.
    const CORE_COLUMNS = new Set(['name', 'liveness', 'rating', 'steps', 'ttft', 'e2e', 'errorRate'])
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
     * The metrics a cell can ask to have scaled, and the row field each one reads.
     *
     * Declared here, beside the bar that draws them, because the bar can only be a
     * share of something the pass measured: a metric missing from this table has no
     * maximum, and `measurementScale` draws nothing for it. A column that wants one
     * added says so by naming a field the host really sends.
     *
     * The list is the metrics, not the columns: a count (`шагов`) is the size of the
     * sample rather than a figure about the model, and a bar under it would be read
     * as "the busiest model" next to a column of latencies.
     *
     * Two columns of the full set are deliberately absent, and the reason belongs
     * here rather than in their cells, so a reader of the table of columns does not
     * have to infer it from cells that look exactly like the four beside them:
     * `префилл` is a share that is *better* when it is low, so a longer bar would read
     * as a worse model — the opposite of every other bar in the table — and `ретраи`
     * is a share of a column whose own comment already says it cannot rank two routes
     * by itself, which a bar would contradict. Both cells used to call
     * `measurementScale` anyway and get `undefined` out of this table, so their markup
     * promised a bar the table never drew; the calls are gone, and
     * `tools/verify-panel-state.mjs` asserts that both still draw none, in the full
     * column set, so the decision cannot be lost by accident.
     */
    const SCALED = {
      ttft: 'ttftMedian',
      tps: 'tpsMedian',
      e2e: 'e2eTpsMedian',
      errorRate: 'errorRate',
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

    /**
     * The age past which a published score stops describing the route as it is and
     * becomes a historical note: 30 days.
     *
     * The host's own `RATING_POLICY.halfLifeDays` is 30, and the rating's own rule
     * is that a measurement 30 days older than the pair's newest usable one counts
     * half — so an anchor further back than that is a score whose evidence has all
     * decayed at least once. The panel cannot import the policy (it has no build
     * step and no importer) any more than it can import the host's constant for
     * anything else, so the number is restated here; the comment is what makes the
     * duplication checkable. It decides a mark, never the score: freshness is
     * descriptive, and a dormant route keeps exactly the rating its history earned.
     *
     * The host marks the same row with the same comparison (`anchorIsStale` in
     * `collect.js`, read off `RATING_POLICY`) and now prints the same `*` in the
     * text report, so the two surfaces cannot describe one score two ways — which
     * was the defect until the report caught up. `tools/verify-rating-paths.mjs`
     * pins the report's half on a frozen clock and the boundary (strict `>`, 30 days
     * exactly is not yet stale) is asserted on both sides.
     */
    const RATING_STALE_MS = 30 * 24 * 60 * 60 * 1000

    /** Whether one row's rating stands on evidence older than {@link RATING_STALE_MS}. */
    function ratingIsStale(rating, now = Date.now()) {
      return finite(rating?.anchor) && now - rating.anchor > RATING_STALE_MS
    }

    /**
     * The marks a published rating can wear beside its number, in the order they
     * are read: thin evidence first, then age.
     *
     * Each one is a glyph with a sentence behind it — in the cell's tooltip for a
     * mouse, in the hidden text for a screen reader, and as a line of its own in
     * the detail block. Two marks rather than one word because they are two
     * different caveats that can hold at once: a route measured well and long ago
     * is not the same row as one measured twice yesterday.
     */
    function ratingMarks(rating) {
      const marks = []
      if (rating?.provisional === true) {
        marks.push({ key: 'provisional', glyph: '~', text: 'rating.provisional' })
      }
      if (ratingIsStale(rating)) {
        marks.push({ key: 'stale', glyph: '*', text: 'rating.stale' })
      }
      return marks
    }

    /**
     * The same two marks, as the legend's one sentence.
     *
     * Composed from the keys {@link ratingMarks} hands the cell's tooltip and its
     * hidden text, so a glyph's meaning exists once in this panel: the legend used
     * to paraphrase it in `note.extra`, and two copies of the same caveat drift
     * apart the first time one of them is edited. The sentence is appended to
     * `note.core` rather than to the expanded half because the rating is one of the
     * seven compact columns — a reader who never presses «все метрики» still sees
     * `~` and `*` in the cell.
     */
    function markLegend(t) {
      return `~ — ${t('rating.provisional')}. * — ${t('rating.stale')}. `
    }

    /**
     * Why one row has no rating: a sentence built from the code the host sent.
     *
     * Four codes, four different facts, and the cell shows the same `-` for all of
     * them — which is why the sentence exists at all. `no_samples` is also the
     * fallback for a row that arrived with no rating at all: a host that predates
     * the column, or a payload that lost the field. An unknown code must not
     * travel as an id no dictionary can explain.
     */
    function ratingReason(row, ctx) {
      const rating = row.rating
      const reason = rating?.reason
      if (reason === 'pair_only') return ctx.t('rating.pairOnly')
      if (reason === 'no_qualified_samples') return ctx.t('rating.noQualified')
      if (reason === 'insufficient_samples') {
        return ctx.t('rating.insufficient', {
          qualified: ctx.fmt.count(rating?.qualifiedSamples),
          effective: ctx.fmt.num(rating?.effectiveSamples, 1),
        })
      }
      return ctx.t('rating.noSamples')
    }

    /**
     * The expanded table's one disclosure: where a row's rating came from.
     *
     * A native `<details>` rather than a tooltip or a popover, because this is the
     * explanation of the one figure in the row that is a verdict: a reader must be
     * able to reach it with a keyboard, and the browser already gives that to a
     * `<summary>` for free. It is rendered only in the expanded column set (see
     * `ctx.showDetails`), and only in the model view: the compact table is one
     * line per row, and a disclosure under every name would spend that line on
     * rows nobody has asked about. The legend's own sentence is what tells a
     * reader it is there.
     *
     * The block carries three kinds of thing, in the order the question arrives:
     * the score and the counts behind it, the measurements and multipliers that
     * produced it, and the route's declared reference data. Price and quotas have
     * no source in this release and say so rather than being left out — an absent
     * line reads as "free" and "unlimited", the one reading that is wrong. A
     * provider row has no single pair to explain, so it gets the pair-only
     * sentence and nothing else.
     */
    function routeDetails(row, ctx) {
      const t = ctx.t
      const fmt = ctx.fmt
      const unknown = t('details.unknown')
      const lines = []

      if (ctx.view === 'provider') {
        lines.push(t('rating.pairOnly'))
      } else {
        const rating = row.rating
        const score = rating?.score
        if (finite(score)) {
          lines.push(
            t('details.rating', {
              version: typeof rating?.version === 'string' ? rating.version : unknown,
              score: fmt.num(score, 1),
            }),
          )
          for (const mark of ratingMarks(rating)) lines.push(t(mark.text))
        } else {
          lines.push(ratingReason(row, ctx))
        }
        // Counts first and the anchor after them: "how much evidence" is the
        // question and "how old" is the caveat on the answer. The two exclusions
        // are counts and not a partition — a step can be both retried and
        // interrupted — and the sentence says so rather than implying a sum.
        lines.push(
          t('details.evidence', {
            qualified: fmt.count(rating?.qualifiedSamples),
            answered: fmt.count(rating?.answeredSamples),
            retried: fmt.count(rating?.excludedRetried),
            interrupted: fmt.count(rating?.excludedInterrupted),
            effective: fmt.num(rating?.effectiveSamples, 1),
            sessions: fmt.count(rating?.sessions),
          }),
        )
        if (finite(rating?.anchor)) {
          lines.push(t('details.anchor', { ago: fmt.ago(rating.anchor) }))
        }
        const inputs = rating?.inputs
        if (finite(inputs?.tpsMedian) || finite(inputs?.ttftMedianMs)) {
          lines.push(
            t('details.measurements', {
              tps: fmt.num(inputs?.tpsMedian, 1),
              ttft: fmt.ms(inputs?.ttftMedianMs),
              ttftP90: fmt.ms(inputs?.ttftP90Ms),
            }),
          )
        }
        const factors = rating?.components
        if (finite(factors?.throughput) || finite(factors?.latency)) {
          lines.push(
            t('details.factors', {
              throughput: fmt.num(factors?.throughput, 2),
              latency: fmt.num(factors?.latency, 2),
              tail: fmt.num(factors?.tailLatency, 2),
            }),
          )
        }
        // The route's own declaration. `routeMetadata: null` is "the adapter was
        // not asked or did not answer" and an object of nulls is "the adapter
        // answered and declares nothing" — two different facts, kept apart here
        // the way the host keeps them apart.
        const route = row.routeMetadata
        if (route === null || route === undefined) {
          lines.push(t('details.referenceNone'))
        } else {
          const modalities = Array.isArray(route.inputModalities)
            ? route.inputModalities.join(', ')
            : unknown
          const efforts = Array.isArray(route.reasoningEfforts) ? route.reasoningEfforts : []
          const names = efforts.map((effort) => effort?.name ?? effort?.id).filter(Boolean)
          // The default is named beside the choices rather than instead of them,
          // and by its display name: it is the mode a request that names none gets,
          // so it is the one a reader comparing two runs of the same model has to
          // know. `defaultReasoningEffort` arrives as an id, and an id whose name
          // the adapter did not send stays an id rather than becoming a dash.
          const fallback =
            typeof route.defaultReasoningEffort === 'string' ? route.defaultReasoningEffort : null
          const chosen =
            fallback === null
              ? null
              : (efforts.find((effort) => effort?.id === fallback)?.name ?? fallback)
          lines.push(
            t('details.reference', {
              // A field the adapter did not declare is named as such rather than
              // shown as the panel's `-`: this line makes a claim about the route
              // ("it declares"), and a dash inside it reads as "we did not look",
              // which is the other of the two facts `routeMetadata` can carry.
              context: finite(route.contextWindow) ? fmt.count(route.contextWindow) : unknown,
              outputCap: finite(route.defaultMaxTokens) ? fmt.count(route.defaultMaxTokens) : unknown,
              modalities,
              reasoning:
                names.length === 0
                  ? unknown
                  : chosen === null
                    ? names.join(', ')
                    : t('details.reasoningDefault', {
                        efforts: names.join(', '),
                        defaultEffort: chosen,
                      }),
            }),
          )
          lines.push(
            t('details.referenceSource', {
              ago: finite(route.checkedAt) ? fmt.ago(route.checkedAt) : unknown,
            }),
          )
        }
        // No source exists for a tariff or a quota in this release, so this line
        // is here to say that rather than to hold a value. A column of dashes
        // would have been the alternative, and a permanent column is worse than
        // one sentence in a block the reader opened on purpose.
        lines.push(t('details.price', { value: t('details.priceUnknown') }))
        lines.push(t('details.caution'))
      }

      return h(
        'details',
        { className: 'dsh-ms-details' },
        h('summary', { className: 'dsh-ms-details-open' }, t('details.summary')),
        h(
          'div',
          { className: 'dsh-ms-details-body' },
          ...lines.map((line, index) =>
            h('p', { key: `${index}`, className: 'dsh-ms-details-line' }, line),
          ),
        ),
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
.dsh-ms-filter-row { display:flex; align-items:center; gap:8px; padding:4px 6px;
  border-radius:var(--dsw-radius-xs, 4px); font-size:12px; color:var(--ms-ink); cursor:pointer;
  touch-action:manipulation; }
.dsh-ms-filter-row:hover, .dsh-ms-tree-row:hover, .dsh-ms-tree-parent:hover { background:var(--ms-hover); }
.dsh-ms-filter-row:focus-within, .dsh-ms-tree-row:focus-within, .dsh-ms-tree-parent:focus-within {
  outline:var(--ms-ring-w) solid var(--ms-ring); outline-offset:-2px; }
.dsh-ms-filter-row input, .dsh-ms-tree-row input, .dsh-ms-tree-parent input {
  margin:0; flex:none; accent-color:var(--ms-accent); }
.dsh-ms-filter-name { flex:1 1 auto; min-width:0; overflow-wrap:anywhere; }
.dsh-ms-filter-count { flex:none; font-size:11px; color:var(--ms-ink-3);
  font-variant-numeric:tabular-nums; }
.dsh-ms-filter-note { font-size:11.5px; line-height:1.45; color:var(--ms-ink-3); text-wrap:pretty; }
/* The models row: the count, the tree behind a disclosure, and the way back. */
.dsh-ms-models { display:flex; align-items:center; gap:6px; min-width:0; flex-wrap:wrap; }
.dsh-ms-models-count { font-variant-numeric:tabular-nums; color:var(--ms-ink-3); font-weight:400; }
/* The tree: a provider, then its models indented under it. The scroll is on the
   list and not on the panel, so the search and the two group buttons stay put
   while a long catalog moves under them — and the panel itself is bounded by the
   viewport, because a reader on a narrow screen must be able to reach the table
   below without hunting for the end of a list. */
.dsh-ms-tree { display:flex; flex-direction:column; gap:2px; max-height:min(52vh, 420px);
  overflow:auto; overscroll-behavior:contain; }
.dsh-ms-tree-group { display:flex; flex-direction:column; gap:1px; }
.dsh-ms-tree-parent { display:flex; align-items:center; gap:8px; padding:5px 6px; margin-top:4px;
  border-radius:var(--dsw-radius-xs, 4px); font-size:12px; font-weight:600; color:var(--ms-ink);
  cursor:pointer; touch-action:manipulation; }
.dsh-ms-tree-group:first-child > .dsh-ms-tree-parent { margin-top:0; }
.dsh-ms-tree-row { display:flex; align-items:center; gap:8px; padding:3px 6px 3px 22px;
  border-radius:var(--dsw-radius-xs, 4px); font-size:12px; color:var(--ms-ink); cursor:pointer;
  touch-action:manipulation; }
/* The full pair is what a checkbox is about, so a long id wraps rather than
   pushing the count out of the panel. */
.dsh-ms-tree-name, .dsh-ms-tree-model { flex:1 1 auto; min-width:0; overflow-wrap:anywhere;
  font-family:var(--ms-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size:11.5px; }
.dsh-ms-tree-count, .dsh-ms-coverage { flex:none; font-size:11px; color:var(--ms-ink-3);
  font-variant-numeric:tabular-nums; }
.dsh-ms-coverage { display:block; }
.dsh-ms-tree-search { width:100%; box-sizing:border-box; padding:5px 8px; font:inherit; font-size:12px;
  color:var(--ms-ink); background:var(--ms-sunken); border:1px solid var(--ms-line);
  border-radius:var(--dsw-radius-xs, 4px); }
.dsh-ms-tree-search:focus-visible { outline:var(--ms-ring-w) solid var(--ms-ring); outline-offset:1px; }
.dsh-ms-tree-actions { display:flex; gap:6px; flex-wrap:wrap; }
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
/* The one mark next to a figure in the table: a rating stands on fewer
   measurements than the panel would like to publish from, and the number is
   printed anyway rather than withheld. It is tertiary ink, not a state colour —
   thin evidence is a caveat on a reading, not a fault, and green or red beside a
   score would be the intelligence grading this column must not do. The gap is on
   the right because the glyph leads the figure: a numeric column is read down the
   right edge of its digits, and a mark printed after the number would move that
   edge on the marked rows alone. */
.dsh-ms-rating-thin { margin-right:2px; color:var(--ms-ink-3); }
/* The route's own detail, folded under the name it belongs to. A native details
   element, so Enter and Space open it and no handler here has to; the summary
   keeps the panel's own ink because it is a control, and the body is the sunken
   well the rest of the panel uses for a block that is a note rather than a
   line. */
.dsh-ms-details { margin-top:3px; font-size:10.5px; color:var(--ms-ink-3); }
.dsh-ms-details-open { cursor:pointer; touch-action:manipulation;
  border-radius:var(--dsw-radius-xs, 4px); }
.dsh-ms-details-open:hover { color:var(--ms-ink-2); text-decoration:underline;
  text-underline-offset:2px; }
.dsh-ms-details-open:focus-visible { outline:var(--ms-ring-w) solid var(--ms-ring);
  outline-offset:-1px; }
.dsh-ms-details-body { margin-top:4px; padding:6px 8px; border:1px solid var(--ms-line);
  border-radius:var(--dsw-radius-sm, 6px); background:var(--ms-sunken);
  color:var(--ms-ink-2); }
.dsh-ms-details-line { margin:0 0 3px; line-height:1.45; overflow-wrap:anywhere; }
.dsh-ms-details-line:last-child { margin-bottom:0; }
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
      // Sort, the view, the archive and the selection are the user's settings, not
      // view state: reopening the panel reopens the same question. The payload
      // cache is keyed by the exact query, so restoring the question also restores
      // an instant first paint instead of a spinner (see `readInitialQuery`).
      const [initialQuery] = React.useState(readInitialQuery)
      const [sort, setSort] = React.useState(initialQuery.sort)
      // The direction is part of the question, not part of the view: it is stored
      // with the rest and sent with every request, so reopening the panel reopens
      // the same order rather than a table that looks reversed next to the arrow it
      // remembers drawing.
      const [dir, setDir] = React.useState(initialQuery.dir)
      const [view, setView] = React.useState(initialQuery.view)
      // Which models the table is about, as rules rather than as a list of pairs —
      // see the selection block near the top of this factory for why the two are
      // not the same thing, and why the rules are what travels to the host.
      const [selection, setSelection] = React.useState(initialQuery.selection)
      // The archive is a scope of the selection and travels with it — same store,
      // same cache key — but it is off until it is asked for: a model the harness
      // no longer serves is not a model to pick, and a table that listed one by
      // default would be recommending it.
      const [archived, setArchived] = React.useState(initialQuery.archived)
      // The tree is opened by the reader and starts closed: a panel that reopened
      // with a hundred checkboxes unfolded would bury the table it is there to
      // filter. The search is navigation only — it hides rows, never changes what a
      // group action means (see `rulesWithProvider`).
      const [treeOpen, setTreeOpen] = React.useState(false)
      const [treeQuery, setTreeQuery] = React.useState('')
      // A selection larger than the page the panel asks for is a fact the panel
      // reports and lets the reader answer, rather than one it hides by asking for
      // more rows than any request should carry (see `MAX_ROWS`).
      const [wholeSelection, setWholeSelection] = React.useState(false)
      // How much of the answer is on the page, and which question that window
      // belongs to. Kept as a pair so the window resets when the question changes
      // without an effect: the harness's React stub runs no effects, and a reset
      // that only exists inside one is a reset no test can reach.
      const [painted, setPainted] = React.useState({ key: null, count: RENDER_ROWS })
      // The deep metrics start collapsed and the choice sticks to the browser
      // across reopenings: the table answers the question first and keeps the
      // deeper figures one click away.
      const [showAllColumns, setShowAllColumns] = React.useState(initialQuery.columnsAll === true)
      // The legend is a footnote, and it starts folded: the table answers its
      // question first.
      const [showLegend, setShowLegend] = React.useState(false)
      // The last answer, whatever query it answered. It is shown immediately
      // when the browser still has it and replaced the moment the host answers;
      // when it is older than the current query it stays on screen and says so.
      const [state, setState] = React.useState(() =>
        querySwitched(
          EMPTY_STATE,
          readCachedPayload(
            initialQuery.sort,
            initialQuery.dir,
            initialQuery.view,
            initialQuery.selection,
            initialQuery.archived,
            false,
          ),
          queryKey(initialQuery.sort, initialQuery.dir, initialQuery.view, initialQuery.selection, initialQuery.archived, false),
        ),
      )
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
            const response = await fetch('/api/model-scorecard/liveness/check', {
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
            const response = await fetch('/api/model-scorecard/liveness', { signal: controller.signal })
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
            // One question, one request, one cache key. The selection goes as rules
            // and not as a resolved list of pairs, because only the host holds the
            // catalog the rules are about: a list the panel resolved from its last
            // answer would miss a model the configuration gained since, and it would
            // miss it exactly where the reader asked for completeness ("all of this
            // provider"). The host resolves, and echoes what it applied.
            //
            // The direction is always named, even in the key's own — the host is
            // asked for an order, not for whatever it would have done on its own.
            // The page size is named for the reason `PAGE_ROWS` gives: a table that
            // lists the configuration cannot be drawn on a host's own idea of a page.
            const response = await fetch('/api/model-scorecard/query', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(
                panelQueryBody({ sort, dir, view, archived, selection, wholeSelection }),
              ),
              signal,
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const data = await response.json()
            if (data.ok === false) throw new Error(data.error ?? 'unknown error')
            writeCachedPayload(sort, dir, view, selection, archived, wholeSelection, data)
            setState(queryAnswered(data, queryKey(sort, dir, view, selection, archived, wholeSelection)))
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
        [sort, dir, view, selection, archived, wholeSelection, fail, say, t],
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
        // Switching the sort, the direction, the view, the selection or the archive
        // switches the query: show what the browser already has for the new one, and
        // when it has nothing, keep the rows that are already on screen rather than
        // blanking the panel while the host is asked.
        setState((prev) =>
          querySwitched(
            prev,
            readCachedPayload(sort, dir, view, selection, archived, wholeSelection),
            queryKey(sort, dir, view, selection, archived, wholeSelection),
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
      }, [load, sort, dir, view, selection, archived, wholeSelection])

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
      // The window belongs to the question that was answered, not to the panel: a new
      // answer to the same question keeps what the reader has already drawn, and an
      // answer to another one starts from the first page again. Derived rather than
      // stored in an effect, because the harness's React stub runs no effects and a
      // reset that only lives in one is a reset nothing can test.
      const paintedRows = painted.key === state.dataQuery ? painted.count : RENDER_ROWS
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

      // The scaled columns carry their own scale (see `measurementScale`): the
      // largest value in a column is the full width of its bar, and every other row
      // is that value's share of it. One row alone has nothing to be compared with
      // and is left without one.
      //
      // One table of maxima for every metric a cell asks to be scaled by, and the
      // ask is what puts a metric in it — the bar is drawn from a lookup rather
      // than from a name the column spells out, so a column that asked for a metric
      // this pass did not measure drew nothing and looked like a column the panel
      // had no opinion about. `SCALED` is the list of what a scaled cell can name;
      // a metric outside it draws no bar, which is the honest answer for a figure
      // with no scale to be a share of.
      const scale = React.useMemo(() => {
        const widest = { rows: rows.length }
        const metrics = Object.keys(SCALED)
        for (const metric of metrics) widest[metric] = 0
        for (const row of rows) {
          for (const metric of metrics) {
            const value = row[SCALED[metric]]
            if (finite(value) && value > widest[metric]) widest[metric] = value
          }
        }
        return widest
      }, [rows])

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

      // Every choice below is a lasting decision, so it is written down as it is
      // made — never in an effect keyed on the value, which would also rewrite the
      // default on a panel the user only glanced at.
      const applyOrder = (nextSort, nextDir) => {
        setSort(nextSort)
        setDir(nextDir)
        writePrefs({ sort: nextSort, dir: nextDir })
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
      }
      // The archive is one checkbox and one decision, and it is written down the
      // way the sort is: the reader chose it, so it outlives the panel. It does not
      // touch the selection — a scope nobody can see is not a scope a switch may
      // edit, so the marks made under it come back exactly as they were left.
      const chooseArchive = (next) => {
        setArchived(next)
        writePrefs({ archived: next })
      }

      // --- the tree, and what a click in it means --------------------------------
      //
      // The catalog is the host's, from the last answer: the panel does not invent
      // a tree out of the rows it was sent, because those rows are the selected ones
      // and a tree that could only offer what is already ticked is not a tree. The
      // checkboxes are the panel's own resolution of the stored rules over that
      // catalog (see `resolveSelection`), which is the same rule the host applies.
      const catalog = React.useMemo(
        () => (Array.isArray(state.data?.catalog) ? state.data.catalog : []),
        [state.data],
      )
      const resolved = React.useMemo(() => resolveSelection(selection, catalog), [selection, catalog])
      // One provider row's own numbers, for the two places that print "N of M":
      // the tree's parent checkbox and the provider view's name cell. Both read the
      // host's `coverage` when it is there, so the number beside a provider row is
      // the host's own count of what it sent, not a second opinion about it.
      const coverageOf = React.useMemo(() => {
        const fromHost = Array.isArray(state.data?.coverage) ? state.data.coverage : null
        const entries = fromHost ?? resolved.providers
        const map = new Map()
        for (const entry of entries) map.set(entry.provider, { selected: entry.selected, total: entry.total })
        return map
      }, [state.data, resolved])
      const catalogTotal = resolved.providers.reduce((sum, entry) => sum + entry.total, 0)

      const applySelection = (next) => {
        setSelection(next)
        writePrefs({ selection: next })
      }
      /**
       * One model's checkbox.
       *
       * The exception is written only where the reader's wish differs from what the
       * rules already say about that pair (see `inheritedPairState`), so a click
       * under "all of this provider" leaves one exception behind and a click under
       * "nothing selected" leaves nothing but the pair itself.
       */
      const choosePair = (scope, provider, model, on) => {
        const inherited = inheritedPairState(selection, scope, provider, model, catalog)
        applySelection(rulesWithPair(selection, scope, provider, model, on, inherited))
      }
      /**
     * One provider's checkbox: all of it, none of it, or only the measured part.
     *
     * Which one is a function of where the group stands rather than of the click
     * alone, so a click reads the host's own count and asks for the next state
     * (`nextProviderRule`): a partial group is finished first, a full one is
     * cleared, and an empty one comes back as its measured models. The rule it
     * writes is what makes the group stay a decision — a model the provider gains
     * later follows it.
     *
     * The scopes it writes are the ones `providerGroupScopes` named, which is
     * both of them for a group that spans both, and the next state is asked for
     * once and written to each: two scopes holding the same rule are one decision
     * about a provider, which is what a single row with a single count promises.
     */
      const chooseProviderGroup = (group, groupRules, counts) => {
        const nextRule = nextProviderRule(groupRules.rule, counts)
        const next = groupRules.scopes.reduce(
          (document, scope) => rulesWithProvider(document, scope, group.provider, nextRule),
          selection,
        )
        applySelection(next)
      }
      const chooseEveryModel = (base) => {
        applySelection(rulesForAll(selection, base, archived))
      }
      // "Reset" restores the rule a first open would have used, and it is a reset of
      // the *selection* and not of a filter: clearing marks is `none`, and a button
      // whose name is "back to the default" has to mean the default.
      const resetSelection = () => {
        applySelection(defaultSelectionRules())
        say(t('announce.selection.reset'))
      }
      const selectionIsDefault = sameSelectionRules(selection, defaultSelectionRules())
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
      // --- the models control -----------------------------------------------------
      //
      // One compact line above the table, and the tree behind a disclosure. The
      // line is what the reader needs on every visit: how many of how many models
      // the table is about. The reset is beside it and always visible — a control
      // that appears only once the reader is already lost is not a way back — and
      // it is inert while the selection already is the default.
      //
      // A row of chips was the alternative and it is the wrong shape here: a
      // selection is a set the reader builds, and a chip per selected model turns
      // the toolbar into a second table to read before the first one.
      const search = treeQuery.trim().toLowerCase()
      const matches = (text) => search === '' || String(text).toLowerCase().includes(search)
      const treeGroups = []
      for (const group of catalog) {
        const models = group.models.filter((entry) => matches(entry.model) || matches(group.provider))
        if (models.length === 0) continue
        const counts = coverageOf.get(group.provider) ?? { selected: 0, total: group.models.length }
        const partial = counts.selected > 0 && counts.selected < counts.total
        // Which scopes this group spans, and the rule it stands on read across all
        // of them: a group is one row with one count, so its click is one decision
        // over the whole group (see `providerGroupScopes`). The rule is named here
        // because the tree reads it to name the one state the marks cannot express —
        // a hand-picked set of exactly the measured models looks the same, and the
        // difference is what happens to a model nobody has run yet.
        const groupRules = providerGroupScopes(group, selection)
        const rule = groupRules.rule
        const measured = rule === 'measured'
        treeGroups.push(
          h(
            'div',
            { className: 'dsh-ms-tree-group', key: group.provider },
            h(
              'label',
              { className: 'dsh-ms-tree-parent' },
              h('input', {
                type: 'checkbox',
                name: 'provider',
                value: group.provider,
                autoComplete: 'off',
                checked: counts.selected === counts.total,
                'aria-checked': partial ? 'mixed' : counts.selected === counts.total ? 'true' : 'false',
                // A partial group is a real indeterminate control in the browser
                // and a `data-state` a test can read: the state is not carried by
                // colour, and it is stated as a number beside the name as well.
                // `measured` is the one state the marks cannot express, so it is
                // named ahead of the partial it usually comes with — the box is
                // still indeterminate, and `aria-checked` still says so.
                'data-state': measured ? 'measured' : partial ? 'partial' : counts.selected === counts.total ? 'all' : 'none',
                ref: (element) => {
                  if (element !== null && element !== undefined) element.indeterminate = partial
                },
                onChange: () => chooseProviderGroup(group, groupRules, counts),
              }),
              h(
                'span',
                { className: 'dsh-ms-tree-name', title: measured ? t('models.provider.measured') : undefined, translate: 'no' },
                group.provider,
              ),
              h(
                'span',
                { className: 'dsh-ms-tree-count' },
                t('models.providerCount', {
                  selected: fmt.count(counts.selected),
                  total: fmt.count(counts.total),
                }),
              ),
            ),
            ...models.map((entry) =>
              h(
                'label',
                { className: 'dsh-ms-tree-row', key: `${group.provider}\u0000${entry.model}` },
                h('input', {
                  type: 'checkbox',
                  name: 'model',
                  value: `${group.provider}\u0000${entry.model}`,
                  autoComplete: 'off',
                  checked: resolved.pairs.has(pairKeyOf(group.provider, entry.model)),
                  onChange: () =>
                    choosePair(
                      // This model's own scope, not the one the group guessed: in a
                      // group of both halves a live model belongs to the live scope,
                      // and an exception written into the archive would govern a
                      // model the reader did not click — the box would answer the
                      // second click instead of the first.
                      entry.archived === true ? 'archive' : 'live',
                      group.provider,
                      entry.model,
                      !resolved.pairs.has(pairKeyOf(group.provider, entry.model)),
                    ),
                }),
                // The full pair, not the shortened label: a checkbox is where the
                // reader decides which of two models with the same name is the one
                // they mean, and the table's shortening is a rendering of a row
                // that is already identified.
                h(
                  'span',
                  { className: 'dsh-ms-tree-model', title: `${group.provider}/${entry.model}`, translate: 'no' },
                  entry.model,
                ),
                entry.noStats === true
                  ? h('span', { className: 'dsh-ms-nostats', title: t('hint.noStats') }, t('noStats.badge'))
                  : null,
                entry.archived === true ? h('span', { className: 'dsh-ms-archive' }, t('archive.badge')) : null,
              ),
            ),
          ),
        )
      }

      const selectionLine = h(
        'span',
        { className: 'dsh-ms-models-count', role: 'status', 'aria-live': 'polite' },
        t('models.count', {
          selected: fmt.count(resolved.pairs.size),
          total: fmt.count(catalogTotal),
        }),
      )
      const modelsControl = h(
        'div',
        { className: 'dsh-ms-models' },
        h(
          'details',
          {
            className: 'dsh-ms-filter',
            open: treeOpen,
            onToggle: (event) => setTreeOpen(event.currentTarget.open === true),
          },
          h(
            'summary',
            { className: 'dsh-ms-chip' },
            t('models.open'),
            selectionLine,
            // The archive is part of the question and it lives inside the folded
            // panel, so the folded panel has to say it is on: a count of selected
            // models over a scope the reader cannot see would describe a different
            // table than the one on screen.
            archived ? h('span', { className: 'dsh-ms-filter-count' }, t('filter.archive.short')) : null,
          ),
          h(
            'div',
            { className: 'dsh-ms-filter-panel', role: 'group', 'aria-label': t('models.group') },
            h('input', {
              type: 'search',
              className: 'dsh-ms-tree-search',
              autoComplete: 'off',
              placeholder: t('models.search'),
              'aria-label': t('models.search'),
              value: treeQuery,
              onChange: (event) => setTreeQuery(event.target.value),
            }),
            h(
              'div',
              { className: 'dsh-ms-tree-actions' },
              h(
                'button',
                { type: 'button', className: 'dsh-ms-chip', onClick: () => chooseEveryModel('all') },
                t('models.selectAll'),
              ),
              h(
                'button',
                { type: 'button', className: 'dsh-ms-chip', onClick: () => chooseEveryModel('none') },
                t('models.selectNone'),
              ),
            ),
            treeGroups.length === 0
              ? h('div', { className: 'dsh-ms-filter-note' }, t('models.empty'))
              : h('div', { className: 'dsh-ms-tree' }, ...treeGroups),
            archiveControl,
          ),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-ms-chip',
            'aria-disabled': selectionIsDefault,
            onClick: () => {
              if (selectionIsDefault) return
              resetSelection()
            },
          },
          t('models.reset'),
        ),
        // A browser that refuses to store anything is worth one sentence: without
        // it the reader would tick models, close the panel, and find the default
        // selection back with no explanation of what happened to their choice.
        storageAvailable()
          ? null
          : h('span', { className: 'dsh-ms-filter-note' }, t('models.storage')),
        // A host that could not read its own catalog grades nothing, and the tree it
        // sent is the history alone. Saying so is the difference between "these are
        // all the models you have" and "these are all I could see": without the
        // sentence, a pair the configuration dropped and one it still serves look
        // exactly alike, and the reader ticks the wrong one.
        state.data !== null && state.data !== undefined && state.data.archive === null
          ? h('span', { className: 'dsh-ms-filter-note' }, t('models.unknownCatalog'))
          : null,
      )

      // Sorting lives in the column headings, so the bar holds only the filter
      // and the toggles — nothing that would name a second place to sort from.
      //
      // The two liveness buttons answer one question at two scopes: every configured
      // model, or the ones the reader ticked. They used to be "all" and "the stale
      // ones", and the second was the worse of the pair — what counted as stale was
      // a five-minute window inside the host, so the button neither said what it
      // would check nor let the reader predict the result. Both buttons now name
      // their scope, and each says what it costs in its own tooltip, because the
      // difference between them is one real request per model.
      // The bar is three clusters, and each one answers a different question:
      // what to compare (the filter), whether the models answer at all (the two
      // scopes of one probe question), and how to read the rows (the view and the
      // column set). The caption is what makes a row of identical chips legible
      // as those three things rather than as six equal buttons.
      const selectedCount = resolved.pairs.size
      const toolbar = h(
        'div',
        { className: 'dsh-ms-bar' },
        modelsControl,
        h(
          'span',
          { className: 'dsh-ms-group' },
          h('span', { className: 'dsh-ms-group-label' }, t('probe.label')),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ms-chip',
              title: t('hint.liveness.all'),
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
          // The selection is the reader's own, resolved over the catalog the host
          // sent — the same resolution the tree's checkboxes are drawn from, so the
          // button and the marks cannot disagree. It travels as the pairs
          // themselves rather than as the rule document, because a check is a
          // question about models and not about the configuration: the host probes a
          // named pair whether or not its catalog still lists it and answers
          // `NO_ROUTE`, which is the fact the reader wanted, where a rule resolved
          // against a catalog would quietly leave that model out.
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ms-chip',
              title: t('hint.liveness.selected'),
              // Nothing ticked is nothing to ask about, and a button that stays
              // live while its question has no answer is a control the reader has
              // to learn the hard way. It is disabled rather than removed: the
              // scope it offers is the one this button is for.
              'aria-disabled': liveRunning || selectedCount === 0,
              onClick: () => {
                if (liveRunning || selectedCount === 0) return
                void startLiveness({ pairs: pairsOf(resolved.pairs) })
              },
            },
            t('action.liveness.selected'),
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
              title: t('hint.columns.all'),
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
      const answered = state.dataQuery === queryKey(sort, dir, view, selection, archived, wholeSelection)
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
        ...rows.slice(0, paintedRows).map((row) => {
          const key = `${row.provider}/${row.model}`
          const cell = livenessView(row, liveOverrides, checkingSet, t, fmt)
          const ctx = {
            view, best: ranked.best, worst: ranked.worst, t, fmt, scale,
            // The identity cell draws the table's one disclosure, and it is drawn
            // only in the expanded column set: it is a fact about the answer to
            // "all metrics", not about the answer to "which model".
            showDetails: showAllColumns,
            // What the provider view prints beside a provider: how many of that
            // provider's models the selection holds. It is the host's own count
            // (`coverage`), so the number in the row and the rows under it are one
            // statement — a partial provider is visibly partial rather than reading
            // as a provider that is simply quiet.
            coverage: coverageOf,
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
      // What the selection kept, as the host counted it over the selected rows —
      // counted before the limit cut them, which is why it is the host's number and
      // not the number of rows on screen. Only shown when a selection is on: without
      // one it would repeat the totals line, and the totals line is about the whole
      // history, not the table.
      const selectedSome = state.data?.selection !== null && state.data?.selection !== undefined
      const shown =
        selectedSome && state.data !== null && state.data !== undefined && state.data.shown
          ? { view, models: state.data.shown.models, steps: state.data.shown.steps }
          : null
      // A selection the page cannot hold in full. The panel says how many rows the
      // selection has and offers to ask for all of them, rather than letting a
      // truncated table read as the whole answer — the one thing a table that lists
      // what the reader chose must not do.
      const truncated = state.data?.truncated === true && wholeSelection === false
      const truncationNotice = truncated
        ? h(
            'div',
            { className: 'dsh-ms-filter-note', role: 'status' },
            t('models.truncated', {
              shown: fmt.count(rows.length),
              total: fmt.count(state.data?.shown?.models ?? rows.length),
            }),
            ' ',
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-ms-chip',
                onClick: () => setWholeSelection(true),
              },
              t('models.showAll'),
            ),
          )
        : null
      // And the bound on this side of the wire. The answer may carry the whole
      // selection — that is what `truncated` and "show all" are for — and the panel
      // still draws one page of it at a time (see `RENDER_ROWS`): the table is then
      // bounded by what the reader asked to look at rather than by what the host had
      // to fold. The notice is below the table on purpose, because that is where a
      // reader who reached the last row is standing when they meet it.
      const paintNotice =
        rows.length > paintedRows
          ? h(
              'div',
              { className: 'dsh-ms-filter-note', role: 'status' },
              t('models.painted', {
                shown: fmt.count(paintedRows),
                total: fmt.count(rows.length),
              }),
              ' ',
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-ms-chip',
                  onClick: () =>
                    setPainted({ key: state.dataQuery, count: paintedRows + RENDER_ROWS }),
                },
                t('models.paintMore', {
                  count: fmt.count(Math.min(RENDER_ROWS, rows.length - paintedRows)),
                }),
              ),
            )
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
      const currentKey = queryKey(sort, dir, view, selection, archived, wholeSelection)
      const behind = state.data !== null && state.data !== undefined && state.dataQuery !== currentKey
      const sortLabel = orderName(sort)
      // The selection is named here for the same reason the archive is: a stale
      // table of every model must not be read as a stale table of the ones the
      // reader asked for. The selection half is dropped when it is the default, so
      // the note of an archive-only question reads as the one thing it asked about.
      const filterParts = [
        selectionIsDefault
          ? null
          : t('models.note', {
              selected: fmt.count(resolved.pairs.size),
              total: fmt.count(catalogTotal),
            }),
        archived ? t('filter.archive.short') : null,
      ].filter((part) => part !== null)
      const filterNote = filterParts.length === 0 ? '' : ` (${filterParts.join(', ')})`

      const kind = contentKind(rows, state)
      let content
      if (kind === 'table') {
        content = h(
          'div',
          { className: 'dsh-ms-wrap' },
          truncationNotice,
          h('table', { className: 'dsh-ms-table' }, header, body),
          paintNotice,
        )
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
          { className: 'dsh-ms-empty', role: 'status' },
          // Four different emptinesses, and the order they are asked in is the
          // order of how actionable they are. An empty *selection* comes first: it
          // is the one state the reader caused and can undo in one click, and a
          // panel that answered it with "no measurements in the history" would be
          // telling them to go and work in a session that is already there. Then the
          // archive, the only other state that names its own remedy — a table
          // emptied by the archive is one checkbox away from having rows. Then the
          // selection that kept nothing from a history that has rows, and last the
          // history itself.
          resolved.pairs.size === 0
            ? h(
                'span',
                null,
                t('empty.selection'),
                ' ',
                h(
                  'button',
                  { type: 'button', className: 'dsh-ms-chip', onClick: resetSelection },
                  t('models.resetDefault'),
                ),
              )
            : archiveRows > 0 && !archived
              ? t('empty.archived', {
                  count: fmt.count(archiveRows),
                  archive: t('filter.archive.short'),
                })
              : selectedSome
                ? t('empty.selected')
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
            // The first two halves are read whatever columns are open; the third
            // is the only one that changes. The rating's marks are in the first,
            // so the table never prints a glyph the legend has not named — and the
            // legend never describes a column the table is not showing.
            t('note.core') + markLegend(t) + (showAllColumns ? t('note.extra') : t('note.collapsed')),
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
      // The pure half of the selection, exported so the suite can pin it against the
      // host's own resolution of the same rule over the same catalog: two
      // implementations of one precedence is the drift this file cannot afford, and
      // a test that only clicked checkboxes would not notice it.
      __test__: {
        MESSAGES,
        // The map of natural directions, so a test can pin it against the fold's
        // own `SORT_DIRECTIONS`: the two cannot import each other, and the copy is
        // the one that drifts silently — a heading that starts a key at the wrong
        // end shows the opposite of what every other heading does on its first
        // click, and nothing else in the suite asks which end that is.
        SORT_DIRS,
        contentKind,
        querySwitched,
        queryAnswered,
        queryFailed,
        canonicalSelectionRules,
        normalizeSelectionRules,
        panelQueryBody,
        resolveSelection,
        sameSelectionRules,
      },
    }
  },
})
