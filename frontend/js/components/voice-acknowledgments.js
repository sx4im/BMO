// Short, local speech cues: no translation/model request on the response path.
// Four openings × three endings provide twelve variants per language and state.
// Search cues are used only after an actual search-start event.
export const VOICE_ACKNOWLEDGMENTS = {
  en: [['Okay.', 'All right.', 'Hmm.', 'Got it.'], ['Let me think.', 'Give me a moment.', "I'll take a look."], ["I'm searching for that now.", "I'll check online.", 'Let me look that up.']],
  bn: [['ঠিক আছে।', 'আচ্ছা।', 'হুম।', 'বুঝেছি।'], ['একটু ভাবছি।', 'একটু সময় দিন।', 'দেখে নিচ্ছি।'], ['এখন খুঁজে দেখছি।', 'অনলাইনে যাচাই করছি।', 'তথ্যটা খুঁজে নিচ্ছি।']],
  bg: [['Добре.', 'Разбира се.', 'Хм.', 'Разбрах.'], ['Нека помисля.', 'Един момент.', 'Ще погледна.'], ['Сега търся това.', 'Ще проверя онлайн.', 'Нека намеря информацията.']],
  ca: [['D’acord.', 'Molt bé.', 'Hmm.', 'Entesos.'], ['Deixa’m pensar.', 'Un moment.', 'Hi faré una ullada.'], ['Ara ho busco.', 'Ho comprovaré en línia.', 'Deixa’m trobar la informació.']],
  zh: [['好的。', '好。', '嗯。', '明白了。'], ['让我想想。', '稍等一下。', '我来看一下。'], ['我正在搜索。', '我上网查一下。', '让我查找相关信息。']],
  hr: [['U redu.', 'Dobro.', 'Hm.', 'Razumijem.'], ['Da razmislim.', 'Samo trenutak.', 'Pogledat ću.'], ['Sada to tražim.', 'Provjerit ću na internetu.', 'Da pronađem te informacije.']],
  cs: [['Dobře.', 'Jistě.', 'Hm.', 'Rozumím.'], ['Nech mě přemýšlet.', 'Chviličku.', 'Podívám se na to.'], ['Právě to hledám.', 'Ověřím to na internetu.', 'Najdu k tomu informace.']],
  da: [['Okay.', 'Godt.', 'Hmm.', 'Forstået.'], ['Lad mig tænke.', 'Et øjeblik.', 'Jeg ser på det.'], ['Jeg søger efter det nu.', 'Jeg tjekker det på nettet.', 'Lad mig finde oplysningerne.']],
  nl: [['Oké.', 'Goed.', 'Hmm.', 'Begrepen.'], ['Laat me nadenken.', 'Een ogenblik.', 'Ik kijk ernaar.'], ['Ik zoek dat nu op.', 'Ik controleer het online.', 'Laat me die informatie zoeken.']],
  et: [['Olgu.', 'Hästi.', 'Hm.', 'Sain aru.'], ['Las ma mõtlen.', 'Üks hetk.', 'Vaatan järele.'], ['Otsin seda praegu.', 'Kontrollin veebist.', 'Las ma otsin selle teabe üles.']],
  fi: [['Selvä.', 'Hyvä.', 'Hmm.', 'Ymmärrän.'], ['Annas kun mietin.', 'Pieni hetki.', 'Katson asiaa.'], ['Etsin sitä nyt.', 'Tarkistan verkosta.', 'Etsin tiedot siitä.']],
  fr: [['D’accord.', 'Très bien.', 'Hmm.', 'Compris.'], ['Laisse-moi réfléchir.', 'Un instant.', 'Je regarde ça.'], ['Je cherche cette information.', 'Je vérifie en ligne.', 'Je vais chercher ça.']],
  de: [['Okay.', 'Alles klar.', 'Hm.', 'Verstanden.'], ['Lass mich überlegen.', 'Einen Moment.', 'Ich schaue mir das an.'], ['Ich suche gerade danach.', 'Ich prüfe das online.', 'Ich suche die Informationen dazu.']],
  gu: [['ઠીક છે.', 'સારું.', 'હમ્મ.', 'સમજાયું.'], ['જરા વિચારવા દો.', 'એક ક્ષણ આપો.', 'હું જોઈ લઉં.'], ['હું હમણાં શોધું છું.', 'હું ઑનલાઇન તપાસું છું.', 'હું એ માહિતી શોધી લઉં.']],
  hi: [['ठीक है।', 'अच्छा।', 'हम्म।', 'समझ गया।'], ['ज़रा सोचने दें।', 'एक पल दीजिए।', 'मैं देख लेता हूँ।'], ['मैं अभी खोज रहा हूँ।', 'मैं ऑनलाइन जाँचता हूँ।', 'मैं यह जानकारी ढूँढ़ लेता हूँ।']],
  hu: [['Rendben.', 'Jó.', 'Hmm.', 'Értem.'], ['Hadd gondolkodjak.', 'Egy pillanat.', 'Megnézem.'], ['Most rákeresek.', 'Ellenőrzöm az interneten.', 'Megkeresem az információt.']],
  id: [['Oke.', 'Baik.', 'Hmm.', 'Mengerti.'], ['Biar saya pikirkan.', 'Sebentar, ya.', 'Saya lihat dulu.'], ['Saya sedang mencarinya.', 'Saya cek di internet.', 'Biar saya cari informasinya.']],
  it: [['Va bene.', 'Bene.', 'Hmm.', 'Capito.'], ['Fammi pensare.', 'Un momento.', 'Do un’occhiata.'], ['Sto cercando questa informazione.', 'Controllo online.', 'Fammi cercare le informazioni.']],
  ja: [['はい。', 'わかりました。', 'うーん。', 'なるほど。'], ['少し考えます。', '少々お待ちください。', '確認してみます。'], ['今、検索しています。', 'ネットで調べます。', '関連する情報を探します。']],
  kn: [['ಸರಿ.', 'ಒಳ್ಳೆಯದು.', 'ಹ್ಮ್.', 'ಅರ್ಥವಾಯಿತು.'], ['ಸ್ವಲ್ಪ ಯೋಚಿಸುತ್ತೇನೆ.', 'ಒಂದು ಕ್ಷಣ ಕೊಡಿ.', 'ನಾನು ನೋಡುತ್ತೇನೆ.'], ['ಈಗ ಹುಡುಕುತ್ತಿದ್ದೇನೆ.', 'ಆನ್‌ಲೈನ್‌ನಲ್ಲಿ ಪರಿಶೀಲಿಸುತ್ತೇನೆ.', 'ಆ ಮಾಹಿತಿಯನ್ನು ಹುಡುಕುತ್ತೇನೆ.']],
  ko: [['네.', '좋아요.', '음.', '알겠습니다.'], ['잠깐 생각해 볼게요.', '잠시만요.', '한번 살펴볼게요.'], ['지금 검색하고 있어요.', '인터넷에서 확인할게요.', '관련 정보를 찾아볼게요.']],
  lv: [['Labi.', 'Jā.', 'Hm.', 'Sapratu.'], ['Ļauj padomāt.', 'Vienu mirkli.', 'Apskatīšu.'], ['Tagad to meklēju.', 'Pārbaudīšu internetā.', 'Sameklēšu šo informāciju.']],
  lt: [['Gerai.', 'Taip.', 'Hm.', 'Supratau.'], ['Leisk pagalvoti.', 'Vieną akimirką.', 'Pažiūrėsiu.'], ['Dabar to ieškau.', 'Patikrinsiu internete.', 'Surasiu šią informaciją.']],
  ms: [['Okey.', 'Baik.', 'Hmm.', 'Faham.'], ['Biar saya fikirkan.', 'Sebentar, ya.', 'Saya tengok dulu.'], ['Saya sedang mencarinya.', 'Saya semak di internet.', 'Biar saya cari maklumat itu.']],
  mr: [['ठीक आहे.', 'बरं.', 'हं.', 'समजलं.'], ['जरा विचार करू द्या.', 'एक क्षण द्या.', 'मी पाहते.'], ['मी आता शोधत आहे.', 'मी ऑनलाइन तपासते.', 'मी ती माहिती शोधते.']],
  el: [['Εντάξει.', 'Ωραία.', 'Χμ.', 'Κατάλαβα.'], ['Ας το σκεφτώ.', 'Μια στιγμή.', 'Θα το κοιτάξω.'], ['Το αναζητώ τώρα.', 'Θα το ελέγξω στο διαδίκτυο.', 'Ας βρω τις πληροφορίες.']],
  no: [['Ok.', 'Greit.', 'Hmm.', 'Forstått.'], ['La meg tenke.', 'Et øyeblikk.', 'Jeg ser på det.'], ['Jeg søker etter det nå.', 'Jeg sjekker på nettet.', 'La meg finne informasjonen.']],
  pl: [['Dobrze.', 'Jasne.', 'Hmm.', 'Rozumiem.'], ['Niech pomyślę.', 'Chwileczkę.', 'Przyjrzę się temu.'], ['Właśnie tego szukam.', 'Sprawdzę to w internecie.', 'Poszukam tych informacji.']],
  pt: [['Certo.', 'Tudo bem.', 'Hum.', 'Entendi.'], ['Deixe-me pensar.', 'Um momento.', 'Vou dar uma olhada.'], ['Estou pesquisando isso agora.', 'Vou verificar na internet.', 'Vou buscar essa informação.']],
  ro: [['Bine.', 'Sigur.', 'Hmm.', 'Am înțeles.'], ['Lasă-mă să mă gândesc.', 'O clipă.', 'Mă uit la asta.'], ['Caut asta acum.', 'Verific pe internet.', 'Lasă-mă să găsesc informația.']],
  ru: [['Хорошо.', 'Ладно.', 'Хм.', 'Понятно.'], ['Дайте подумать.', 'Одну минутку.', 'Сейчас посмотрю.'], ['Сейчас ищу это.', 'Проверю в интернете.', 'Найду эту информацию.']],
  sk: [['Dobre.', 'Jasné.', 'Hm.', 'Rozumiem.'], ['Nechajte ma premýšľať.', 'Chvíľočku.', 'Pozriem sa na to.'], ['Práve to hľadám.', 'Overím to na internete.', 'Nájdem tieto informácie.']],
  sl: [['V redu.', 'Prav.', 'Hm.', 'Razumem.'], ['Naj razmislim.', 'Samo trenutek.', 'Pogledam.'], ['Zdaj to iščem.', 'Preverim na spletu.', 'Poiščem te informacije.']],
  es: [['Vale.', 'De acuerdo.', 'Mmm.', 'Entendido.'], ['Déjame pensar.', 'Un momento.', 'Voy a revisarlo.'], ['Estoy buscando esa información.', 'Voy a comprobarlo en internet.', 'Déjame buscarlo.']],
  sv: [['Okej.', 'Bra.', 'Hmm.', 'Jag förstår.'], ['Låt mig tänka.', 'Ett ögonblick.', 'Jag tittar på det.'], ['Jag söker efter det nu.', 'Jag kollar på nätet.', 'Låt mig hitta informationen.']],
  tl: [['Sige.', 'Okey.', 'Hmm.', 'Naintindihan ko.'], ['Pag-isipan ko muna.', 'Sandali lang.', 'Titingnan ko.'], ['Hinahanap ko na ngayon.', 'Titingnan ko sa internet.', 'Hahanapin ko ang impormasyon.']],
  ta: [['சரி.', 'நல்லது.', 'ம்.', 'புரிந்தது.'], ['சற்று யோசிக்கிறேன்.', 'ஒரு நிமிடம்.', 'நான் பார்க்கிறேன்.'], ['இப்போது தேடுகிறேன்.', 'இணையத்தில் சரிபார்க்கிறேன்.', 'அந்தத் தகவலைத் தேடுகிறேன்.']],
  te: [['సరే.', 'మంచిది.', 'హ్మ్.', 'అర్థమైంది.'], ['కాస్త ఆలోచిస్తాను.', 'ఒక్క క్షణం.', 'నేను చూస్తాను.'], ['ఇప్పుడు వెతుకుతున్నాను.', 'ఆన్‌లైన్‌లో తనిఖీ చేస్తాను.', 'ఆ సమాచారాన్ని వెతుకుతాను.']],
  tr: [['Tamam.', 'Peki.', 'Hmm.', 'Anladım.'], ['Bir düşüneyim.', 'Bir dakika.', 'Bir bakayım.'], ['Şimdi bunu arıyorum.', 'İnternetten kontrol edeceğim.', 'Bilgiyi bulayım.']],
  uk: [['Добре.', 'Гаразд.', 'Хм.', 'Зрозуміло.'], ['Дайте подумати.', 'Одну хвилинку.', 'Зараз подивлюся.'], ['Зараз шукаю це.', 'Перевірю в інтернеті.', 'Знайду цю інформацію.']],
  ur: [['ٹھیک ہے۔', 'اچھا۔', 'ہمم۔', 'سمجھ گئی۔'], ['ذرا سوچنے دیں۔', 'ایک لمحہ دیں۔', 'میں دیکھتی ہوں۔'], ['میں ابھی تلاش کر رہی ہوں۔', 'میں آن لائن دیکھتی ہوں۔', 'میں یہ معلومات ڈھونڈ لیتی ہوں۔']],
  vi: [['Được rồi.', 'Vâng.', 'Ừm.', 'Tôi hiểu rồi.'], ['Để tôi suy nghĩ.', 'Chờ một chút nhé.', 'Tôi sẽ xem thử.'], ['Tôi đang tìm thông tin đó.', 'Tôi sẽ kiểm tra trên mạng.', 'Để tôi tìm thông tin này.']],
};

export function voiceAcknowledgments(language, kind = 'thinking') {
  const row = VOICE_ACKNOWLEDGMENTS[String(language).split(/[-_]/)[0]] || VOICE_ACKNOWLEDGMENTS.en;
  return row[0].flatMap(opening => row[kind === 'search' ? 2 : 1].map(ending => `${opening} ${ending}`));
}

const previous = new Map();
export function getVoiceAcknowledgment(language, kind = 'thinking') {
  const choices = voiceAcknowledgments(language, kind);
  const key = `${language}:${kind}`;
  const last = previous.get(key);
  let index = Math.floor(Math.random() * choices.length);
  if (index === last) index = (index + 1) % choices.length;
  previous.set(key, index);
  return choices[index];
}
