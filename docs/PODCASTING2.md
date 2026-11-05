# Справочник Podcasting 2.0

Снимок спецификации: [d4036dcb1047ad654682e1142734e3acf2c13f37](https://github.com/Podcastindex-org/podcast-namespace/tree/d4036dcb1047ad654682e1142734e3acf2c13f37).

31 действующий тег и устаревший images. Таблица генерируется из правил CLI командой `npm run docs`.

У тегов с родителем item также допустим родитель podcast:liveItem. Все имена тегов таблицы имеют namespace podcast. Теги необязательны; «один» означает не более одного у одного родителя. Указанные атрибуты обязательны, только когда присутствует сам тег.

| Тег | Родители | Количество | Обязательные атрибуты | Остальные атрибуты | Дочерние теги |
| --- | --- | --- | --- | --- | --- |
| transcript | item | Несколько | url, type | language, rel | — |
| locked | channel | Один | — | owner | — |
| funding | channel, item | Несколько | url | — | — |
| chapters | item | Один | url, type | — | — |
| soundbite | item | Несколько | startTime, duration | — | — |
| person | channel, item | Несколько | — | role, group, img, href | — |
| location | channel, item | Несколько | — | rel, geo, osm, country | — |
| season | item | Один | — | name | — |
| episode | item | Один | — | display | — |
| trailer | channel | Несколько | url, pubdate | length, type, season | — |
| license | channel, item | Один | — | url | — |
| alternateEnclosure | item | Несколько | type | length, bitrate, height, lang, title, rel, codecs, default | source, integrity |
| source | alternateEnclosure | Несколько | uri | contentType | — |
| integrity | alternateEnclosure | Один | type, value | — | — |
| guid | channel | Один | — | — | — |
| value | channel, item | Несколько | type, method | suggested | valueRecipient, valueTimeSplit |
| valueRecipient | value, valueTimeSplit | Несколько | type, address, split | name, customKey, customValue, fee | — |
| medium | channel | Один | — | — | — |
| liveItem | channel | Несколько | status, start | end | * |
| contentLink | item | Несколько | href | — | — |
| socialInteract | channel, item | Несколько | protocol | uri, accountId, accountUrl, priority | — |
| block | channel | Несколько | — | id | — |
| txt | channel, item | Несколько | — | purpose | — |
| remoteItem | channel, podroll, valueTimeSplit, publisher | Несколько | feedGuid | feedUrl, itemGuid, medium, title | — |
| podroll | channel | Один | — | — | remoteItem |
| updateFrequency | channel | Один | — | complete, dtstart, rrule | — |
| podping | channel | Один | usesPodping | — | — |
| valueTimeSplit | value | Несколько | startTime, duration | remoteStartTime, remotePercentage | remoteItem, valueRecipient |
| chat | channel, item | Один | server, protocol | accountId, space | — |
| publisher | channel | Один | — | — | remoteItem |
| image | channel, item | Несколько | href | alt, aspect-ratio, width, height, type, purpose | — |
| images | channel, item | Один | srcset | — | — |

## Связанные условия

- **transcript**: MIME-тип, язык BCP 47 и опциональный rel=captions. Файл не загружается.
- **locked, block**: текст yes/no; используйте кавычки в YAML для однозначности.
- **funding, person, location, trailer, license**: непустое текстовое значение; длина свыше 128 символов даёт предупреждение.
- **chapters**: обычно type=application/json+chapters; проверяется MIME-синтаксис, не содержимое JSON.
- **soundbite**: неотрицательный startTime, положительная duration; значения в секундах, допускаются дроби.
- **location**: rel=subject/creator, geo URI с диапазонами WGS84, высотой, CRS и неотрицательной погрешностью u; OSM-идентификатор N/W/R и число; country — две заглавные буквы. Несколько географических тегов разрешены.
- **season**: целочисленный текст; name — название сезона. **episode**: десятичное число; display — альтернативное обозначение.
- **trailer**: pubdate в RFC 2822, в отличие от ISO-дат liveItem.
- **license**: для пользовательской лицензии требуется url; известные идентификаторы берутся из зафиксированного списка.
- **alternateEnclosure**: минимум один source; не больше одного integrity. default — true/false.
- **source**: абсолютный URI; кроме HTTPS поддерживаются альтернативные схемы вроде IPFS.
- **integrity**: type=sri/pgp-signature; синтаксис SRI (SHA-256/384/512, base64/base64url, необязательные options) или base64 для PGP. Содержимое медиа и действительность подписи не проверяются.
- **guid**: UUIDv5 подкаста; это отдельное поле от RSS guid выпуска.
- **value**: минимум один valueRecipient; разрешены valueTimeSplit.
- **valueRecipient**: split — неотрицательное целое; сумма долей группы больше нуля, но не обязательно 100. customKey/customValue задаются вместе. Для node и lnaddress проверяется форма адреса.
- **valueTimeSplit**: ровно один remoteItem ИЛИ один/несколько valueRecipient. startTime неотрицательный, duration положительная. remotePercentage за пределами 0–100 даёт предупреждение о поведении клиентов.
- **medium**: podcast, music, video, film, audiobook, newsletter, blog, publisher, course; их варианты с суффиксом L и mixed. List-фид требует remoteItem и не содержит item/liveItem; publisher требует guid и remoteItem. CLI создаёт подкаст с эпизодами; publisher/list-фиды без эпизодов не проходят общий профиль платформ.
- **liveItem**: status=pending/live/ended, ISO start, end позже start; title, guid, contentLink и основной или альтернативный enclosure. `*` в таблице означает дочерние теги обычного item. В YAML стандартные элементы пишутся с префиксом rss:. CLI не запускает эфир и не отправляет уведомления.
- **socialInteract**: protocol=disabled запрещает остальные атрибуты; во всех других случаях нужен uri. Неизвестный протокол даёт предупреждение.
- **txt**: purpose=ai-content требует текст true/false; прочие purpose свободные.
- **remoteItem**: feedGuid — UUIDv5; itemGuid — идентификатор элемента удалённого фида.
- **podroll**: минимум один remoteItem.
- **updateFrequency**: RRULE проверяется по компонентам, календарным датам, диапазонам и связям BY*/FREQ. COUNT требует dtstart и исключает UNTIL; UNTIL и dtstart должны иметь одинаковый тип date/datetime. При dtstart с часовым поясом UNTIL должен быть в UTC. Для даты без времени запрещены BYHOUR/BYMINUTE/BYSECOND. Календарь не вычисляется.
- **podping**: usesPodping=true/false; значение описывает внешнюю интеграцию, а не включает отправку уведомлений CLI.
- **chat**: server — доменное имя, protocol — протокол чата.
- **publisher**: ровно один remoteItem с medium=publisher.
- **image**: href обязателен; размеры — положительные целые, aspect-ratio — литеральное неотрицательное CSS-число, отношение или auto, в том числе auto с отношением. CSS-функции не вычисляются. alt может быть пустым. purpose — свободный список токенов. Медиа не проверяется.
- **images**: устаревший srcset; поддерживаются абсолютные HTTPS-адреса с положительными дескрипторами w/x, через запятую; запятые внутри URL сохраняются. Дескрипторы не повторяются, w и x не смешиваются. Использование вызывает предупреждение.

Строки и атрибуты XML экранируются автоматически. Неизвестные теги/атрибуты Podcasting 2.0 и незнакомые значения открытых реестров дают предупреждение, в режиме --strict блокируют запись. Ошибочные обязательные атрибуты, родители и вложенность — ошибки.

Примеры: [channel](../examples/podcast-full.yaml), [item](../examples/episode-full.yaml). Источники и границы: [SOURCES.md](SOURCES.md).
