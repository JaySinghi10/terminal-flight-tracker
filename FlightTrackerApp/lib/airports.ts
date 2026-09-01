// IATA airport code -> airport, city, country, timezone.
//
// Generated from OurAirports (public domain) for the classification and the
// scheduled-service flag, joined to github.com/mwgg/Airports for the IANA
// timezone, which OurAirports does not carry. The trim is:
//
//     scheduled_service = yes  AND  a real IATA code  AND
//     ( large_airport  OR  ( medium_airport AND country = IN ) )
//
// which was 1,212 airports. Large-only would be 1,149 and drops Patna,
// Madurai, Raipur and Hubballi; every scheduled airport would be 4,134. The
// India clause is a deliberate bias towards the routes this app is actually
// used for, not an accident of the data.
//
// ELEVEN rows are added on top of that trim, by hand, and the file now holds
// 1,223. Ten are Indian airports OurAirports calls "small" that carry
// scheduled_service = yes: the size class was excluded by a line drawn for
// convenience, not by anything true about the flights, and all ten are real
// destinations. The eleventh is BUP, which the source marks
// scheduled_service = no and which nonetheless appears on live boards.
//
// Airports the source calls dormant are otherwise NOT added. An airport in
// here that no longer flies is worse than one that is absent, because it can
// be matched.
//
// THIRTEEN INDIAN ROWS are corrected by hand on top of that, in two ways that
// are worth telling apart.
//
// EIGHT had their `city` changed, because OurAirports files an airport under
// the municipality that administers the land rather than the place the airport
// is named for and ticketed as. Kakadi is where Shirdi's airport sits; nobody
// flies to Kakadi. In every one of the eight the old municipality is kept in
// the row's `search`, so the change is to what is DISPLAYED and never to what
// can be found:
//
//     AYJ Faizabad -> Ayodhya          KJB Orvakal      -> Kurnool
//     DXN Gautam Buddha Nagar -> Noida KUU Bhuntar      -> Kullu
//     SAG Kakadi   -> Shirdi           SDW Chipi        -> Sindhudurg
//     DHM Kangra   -> Dharamshala      RJA Madhurapudi  -> Rajahmundry
//
// SEVEN gained an alias for a name the row could not be found by. Two of them
// are the same problem pointing opposite ways: the source has Hubballi's
// current name and not its old one, and Mysore's old name and not its current
// one, so "Hubli" and "Mysuru" both missed. The rest are the colloquial name
// ("Trichy"), a renamed city ("Gulbarga"), or the village the airport stands in
// where the airport is named for the city ("Hirasar", "Jewar", "Dharamshala").
//
// Where a row gained its FIRST `search`, every base term is restated in it.
// That field REPLACES the derived "name city" haystack rather than extending
// it, so a row that adds one and forgets its own name stops being findable by
// it. See the note on Row below.
//
// Three Indian airports people do search for are absent and stay absent: RRK
// Rourkela, KBK Kushinagar and SSE Solapur. Adding them means reopening the
// trim rule at the top of this file, which is a decision about the dataset
// rather than a correction to it.
//
// Data only: no imports, no state, no network. Nothing here is sourced from the
// flight data provider, and nothing here is fetched at runtime.
export type Airport = {
  iata: string;
  name: string;
  city: string;
  country: string;
  tz: string;
  lat: number;
  lon: number;
};

// [iata, name, city, country, tz, lat, lon, search?]
//
// `search` is the lowercase haystack for name matching, and it is present only
// when it differs from "name city" — for the 255 rows carrying an alias, a
// discarded municipality tail, or a diacritic. Where a row has diacritics the
// folded ASCII copy is appended, so "Sao Paulo" and "São Paulo" both hit and
// the device never has to normalize Unicode at runtime.
type Row = [string, string, string, string, string, number, number, string?];

const AIRPORT_ROWS: Row[] = [
  ["AAC", "El Arish International Airport", "El Arish", "Egypt", "Africa/Cairo", 31.0553, 33.8280],
  ["AAE", "Annaba Rabah Bitat Airport", "Annaba", "Algeria", "Africa/Algiers", 36.8268, 7.8133],
  ["AAL", "Aalborg Airport", "Aalborg", "Denmark", "Europe/Copenhagen", 57.0948, 9.8499],
  ["AAN", "Al Ain International Airport", "Al Ain", "United Arab Emirates", "Asia/Dubai", 24.2617, 55.6092],
  ["AAR", "Aarhus Airport", "Aarhus", "Denmark", "Europe/Copenhagen", 56.3033, 10.6183],
  ["ABA", "Abakan International Airport", "Abakan", "Russia", "Asia/Krasnoyarsk", 53.7400, 91.3850],
  ["ABB", "Asaba International Airport", "Asaba", "Nigeria", "Africa/Lagos", 6.2042, 6.6653],
  ["ABD", "Abadan Ayatollah Jami International Airport", "Abadan", "Iran", "Asia/Tehran", 30.3679, 48.2301],
  ["ABJ", "Félix-Houphouët-Boigny International Airport", "Abidjan", "Côte d'Ivoire", "Africa/Abidjan", 5.2614, -3.9263, "félix houphouët boigny international airport abidjan felix houphouet boigny international airport abidjan"],
  ["ABQ", "Albuquerque International Sunport", "Albuquerque", "United States", "America/Denver", 35.0400, -106.6089],
  ["ABV", "Nnamdi Azikiwe International Airport", "Abuja", "Nigeria", "Africa/Lagos", 9.0068, 7.2632],
  ["ABZ", "Aberdeen International Airport", "Aberdeen", "United Kingdom", "Europe/London", 57.2019, -2.1978],
  ["ACA", "General Juan N. Álvarez International Airport", "Acapulco", "Mexico", "America/Mexico_City", 16.7571, -99.7531, "general juan n álvarez international airport acapulco general juan n alvarez international airport acapulco"],
  ["ACC", "Kotoka International Airport", "Accra", "Ghana", "Africa/Accra", 5.6052, -0.1668],
  ["ACE", "César Manrique-Lanzarote Airport", "San Bartolomé", "Spain", "Atlantic/Canary", 28.9455, -13.6052, "césar manrique lanzarote airport san bartolomé cesar manrique lanzarote airport san bartolome"],
  ["ADB", "Adnan Menderes International Airport", "Gaziemir", "Turkey", "Europe/Istanbul", 38.2924, 27.1570],
  ["ADD", "Addis Ababa Bole International Airport", "Addis Ababa", "Ethiopia", "Africa/Addis_Ababa", 8.9779, 38.7993],
  ["ADE", "Aden International Airport", "Aden", "Yemen", "Asia/Aden", 12.8296, 45.0300],
  ["ADJ", "Marka International (Amman Civil) Airport", "Amman", "Jordan", "Asia/Amman", 31.9727, 35.9916],
  ["ADL", "Adelaide International Airport", "Adelaide", "Australia", "Australia/Adelaide", -34.9475, 138.5334],
  ["ADZ", "Gustavo Rojas Pinilla International Airport", "San Andrés", "Colombia", "America/Bogota", 12.5836, -81.7112, "gustavo rojas pinilla international airport san andrés gustavo rojas pinilla international airport san andres"],
  ["AEP", "Aeroparque Jorge Newbery", "Buenos Aires", "Argentina", "America/Argentina/Buenos_Aires", -34.5594, -58.4155],
  ["AER", "Sochi International Airport", "Sochi", "Russia", "Europe/Moscow", 43.4499, 39.9566],
  ["AES", "Ålesund Airport", "Ålesund", "Norway", "Europe/Oslo", 62.5604, 6.1108, "ålesund airport ålesund alesund airport alesund"],
  ["AEY", "Akureyri International Airport", "Akureyri", "Iceland", "Atlantic/Reykjavik", 65.6566, -18.0720],
  ["AGA", "Al Massira Airport", "Agadir", "Morocco", "Africa/Casablanca", 30.3225, -9.4120, "al massira airport agadir temsia"],
  ["AGP", "Málaga-Costa del Sol Airport", "Málaga", "Spain", "Europe/Madrid", 36.6749, -4.4991, "málaga costa del sol airport málaga malaga costa del sol airport malaga"],
  ["AGR", "Agra Airport / Agra Air Force Station", "Agra", "India", "Asia/Kolkata", 27.1580, 77.9610],
  ["AGT", "Guaraní International Airport", "Ciudad del Este", "Paraguay", "America/Asuncion", -25.4572, -54.8395, "guaraní international airport ciudad del este guarani international airport ciudad del este"],
  ["AGU", "Aguascalientes International Airport", "Aguascalientes", "Mexico", "America/Mexico_City", 21.6996, -102.3184],
  ["AGX", "Agatti Airport", "Agatti", "India", "Asia/Kolkata", 10.8237, 72.1760],
  ["AHA", "Maa Mahamaya Airport", "Ambikapur", "India", "Asia/Kolkata", 22.9875, 83.1961],
  ["AHB", "Abha International Airport", "Abha", "Saudi Arabia", "Asia/Riyadh", 18.2404, 42.6566],
  ["AIP", "Adampur Airport", "Adampur", "India", "Asia/Kolkata", 31.4338, 75.7588],
  ["AJF", "Al-Jawf International Airport", "Al-Jawf", "Saudi Arabia", "Asia/Riyadh", 29.7833, 40.1009],
  ["AJL", "Lengpui Airport", "Aizawl", "India", "Asia/Kolkata", 23.8406, 92.6197],
  ["AKL", "Auckland International Airport", "Auckland", "New Zealand", "Pacific/Auckland", -37.0120, 174.7863],
  ["AKX", "Aktobe International Airport", "Aktobe", "Kazakhstan", "Asia/Aqtobe", 50.2481, 57.2041],
  ["ALA", "Almaty International Airport", "Almaty", "Kazakhstan", "Asia/Almaty", 43.3543, 77.0428],
  ["ALB", "Albany International Airport", "Albany", "United States", "America/New_York", 42.7483, -73.8017],
  ["ALC", "Alicante-Elche Miguel Hernández Airport", "Alicante", "Spain", "Europe/Madrid", 38.2822, -0.5582, "alicante elche miguel hernández airport alicante alicante elche miguel hernandez airport alicante"],
  ["ALG", "Houari Boumediene Airport", "Algiers", "Algeria", "Africa/Algiers", 36.6939, 3.2145],
  ["ALP", "Aleppo International Airport", "Aleppo", "Syria", "Asia/Damascus", 36.1813, 37.2269],
  ["AMD", "Sardar Vallabh Patel International Airport", "Ahmedabad", "India", "Asia/Kolkata", 23.0772, 72.6347],
  ["AMM", "Queen Alia International Airport", "Amman", "Jordan", "Asia/Amman", 31.7226, 35.9932],
  ["AMQ", "Pattimura International Airport", "Ambon", "Indonesia", "Asia/Jayapura", -3.7103, 128.0890],
  ["AMS", "Amsterdam Airport Schiphol", "Amsterdam", "Netherlands", "Europe/Amsterdam", 52.3086, 4.7639],
  ["ANC", "Ted Stevens Anchorage International Airport", "Anchorage", "United States", "America/Anchorage", 61.1790, -149.9926],
  ["ANF", "Andrés Sabella Gálvez International Airport", "Antofagasta", "Chile", "America/Santiago", -23.4453, -70.4452, "andrés sabella gálvez international airport antofagasta andres sabella galvez international airport antofagasta"],
  ["ANU", "V. C. Bird International Airport", "Osbourn", "Antigua and Barbuda", "America/Antigua", 17.1367, -61.7927],
  ["AOE", "Hasan Polatkan Airport", "Eskişehir", "Turkey", "Europe/Istanbul", 39.8116, 30.5193, "hasan polatkan airport eskişehir hasan polatkan airport eskisehir"],
  ["AOJ", "Aomori Airport", "Aomori", "Japan", "Asia/Tokyo", 40.7338, 140.6895],
  ["APL", "Nampula Airport", "Nampula", "Mozambique", "Africa/Maputo", -15.1056, 39.2818],
  ["APW", "Faleolo International Airport", "Apia", "Samoa", "Pacific/Apia", -13.8300, -172.0080],
  ["AQI", "Qaisumah–Hafar Al-Batin International Airport", "Qaisumah", "Saudi Arabia", "Asia/Riyadh", 28.3357, 46.1271],
  ["AQJ", "King Hussein International Airport", "Aqaba", "Jordan", "Asia/Amman", 29.6116, 35.0181],
  ["AQP", "Rodríguez Ballón International Airport", "Arequipa", "Peru", "America/Lima", -16.3408, -71.5695, "rodríguez ballón international airport arequipa rodriguez ballon international airport arequipa"],
  ["ARN", "Stockholm-Arlanda Airport", "Stockholm", "Sweden", "Europe/Stockholm", 59.6485, 17.9288],
  ["ASB", "Ashgabat International Airport", "Ashgabat", "Turkmenistan", "Asia/Ashgabat", 37.9868, 58.3610],
  ["ASF", "Astrakhan Narimanovo Boris M. Kustodiev International Airport", "Astrakhan", "Russia", "Europe/Astrakhan", 46.2828, 48.0105],
  ["ASR", "Kayseri Erkilet International Airport", "Kayseri", "Turkey", "Europe/Istanbul", 38.7704, 35.4954],
  ["ASU", "Silvio Pettirossi International Airport", "Asunción", "Paraguay", "America/Asuncion", -25.2402, -57.5192, "silvio pettirossi international airport asunción silvio pettirossi international airport asuncion"],
  ["ASW", "Aswan International Airport", "Aswan", "Egypt", "Africa/Cairo", 23.9611, 32.8204],
  ["ATH", "Athens Eleftherios Venizelos International Airport", "Spata-Artemida", "Greece", "Europe/Athens", 37.9364, 23.9445],
  ["ATL", "Hartsfield Jackson Atlanta International Airport", "Atlanta", "United States", "America/New_York", 33.6367, -84.4281],
  ["ATQ", "Sri Guru Ram Das Ji International Airport", "Amritsar", "India", "Asia/Kolkata", 31.7096, 74.7973],
  ["ATZ", "Asyut International Airport", "Asyut", "Egypt", "Africa/Cairo", 27.0460, 31.0128],
  ["AUA", "Queen Beatrix International Airport", "Oranjestad", "Aruba", "America/Aruba", 12.5011, -70.0143],
  ["AUH", "Zayed International Airport", "Abu Dhabi", "United Arab Emirates", "Asia/Dubai", 24.4410, 54.6492],
  ["AUS", "Austin Bergstrom International Airport", "Austin", "United States", "America/Chicago", 30.1975, -97.6620],
  ["AVR", "Amravati Airport", "Amravati", "India", "Europe/Lisbon", 20.8146, 77.7178],
  ["AVV", "Melbourne Avalon International Airport", "Geelong", "Australia", "Australia/Melbourne", -38.0403, 144.4672],
  ["AWA", "Hawassa International Airport", "Hawassa", "Ethiopia", "Africa/Addis_Ababa", 7.1006, 38.3965],
  ["AWZ", "Qasem Soleimani International Airport", "Ahvaz", "Iran", "Asia/Tehran", 31.3364, 48.7638],
  ["AYJ", "Maharshi Valmiki International Airport", "Ayodhya", "India", "Asia/Kolkata", 26.7477, 82.1637, "maharshi valmiki international airport faizabad ayodhya ayodkhya"],
  ["AYT", "Antalya International Airport", "Antalya", "Turkey", "Europe/Istanbul", 36.8987, 30.8005],
  ["BAH", "Bahrain International Airport", "Manama", "Bahrain", "Asia/Bahrain", 26.2673, 50.6376],
  ["BAQ", "Ernesto Cortissoz International Airport", "Barranquilla", "Colombia", "America/Bogota", 10.8896, -74.7808],
  ["BAV", "Baotou Donghe International Airport", "Baotou", "China", "Asia/Shanghai", 40.5600, 109.9970],
  ["BAX", "Barnaul Gherman Titov International Airport", "Barnaul", "Russia", "Asia/Barnaul", 53.3613, 83.5397],
  ["BBI", "Biju Patnaik International Airport", "Bhubaneswar", "India", "Asia/Kolkata", 20.2510, 85.8147],
  ["BBK", "Kasane International Airport", "Kasane", "Botswana", "Africa/Gaborone", -17.8317, 25.1662],
  ["BBU", "Bucharest Băneasa Aurel Vlaicu International Airport", "Bucharest", "Romania", "Europe/Bucharest", 44.5031, 26.1029, "bucharest băneasa aurel vlaicu international airport bucharest bucharest baneasa aurel vlaicu international airport bucharest"],
  ["BCD", "Bacolod-Silay International Airport", "Bacolod City", "Philippines", "Asia/Manila", 10.7762, 123.0189],
  ["BCM", "Bacău George Enescu International Airport", "Bacău", "Romania", "Europe/Bucharest", 46.5219, 26.9103, "bacău george enescu international airport bacău bacau george enescu international airport bacau"],
  ["BCN", "Josep Tarradellas Barcelona-El Prat Airport", "Barcelona", "Spain", "Europe/Madrid", 41.2971, 2.0785],
  ["BCU", "Sir Abubakar Tafawa Balewa Bauchi State International Airport", "Bauchi", "Nigeria", "Africa/Lagos", 10.4828, 9.7440],
  ["BDA", "L.F. Wade International Airport", "Hamilton", "Bermuda", "Atlantic/Bermuda", 32.3638, -64.6782],
  ["BDJ", "Syamsudin Noor International Airport", "Banjarbaru", "Indonesia", "Asia/Makassar", -3.4401, 114.7612],
  ["BDL", "Bradley International Airport", "Hartford", "United States", "America/New_York", 41.9386, -72.6880],
  ["BDQ", "Vadodara International Airport", "Vadodara", "India", "Asia/Kolkata", 22.3362, 73.2263],
  ["BDS", "Brindisi Airport", "Brindisi", "Italy", "Europe/Rome", 40.6576, 17.9470],
  ["BEG", "Belgrade Nikola Tesla Airport", "Belgrade", "Serbia", "Europe/Belgrade", 44.8184, 20.3091],
  ["BEK", "Bareilly Air Force Station", "Bareilly", "India", "Asia/Kolkata", 28.4221, 79.4508],
  ["BEL", "Val de Cans/Júlio Cezar Ribeiro International Airport", "Belém", "Brazil", "America/Belem", -1.3793, -48.4762, "val de cans júlio cezar ribeiro international airport belém val de cans julio cezar ribeiro international airport belem"],
  ["BEM", "Beni Mellal Airport", "Oulad Yaich", "Morocco", "Africa/Casablanca", 32.4019, -6.3159],
  ["BEN", "Benina International Airport", "Benina", "Libya", "Africa/Tripoli", 32.0968, 20.2695],
  ["BER", "Berlin Brandenburg Airport", "Berlin", "Germany", "Europe/Berlin", 52.3617, 13.5023],
  ["BES", "Brest Bretagne airport", "Brest", "France", "Europe/Paris", 48.4479, -4.4185],
  ["BEW", "Beira International Airport", "Beira", "Mozambique", "Africa/Maputo", -19.7964, 34.9076],
  ["BEY", "Beirut Rafic Hariri International Airport", "Beirut", "Lebanon", "Asia/Beirut", 33.8198, 35.4874],
  ["BFN", "Bram Fischer International Airport", "Bloemfontein", "South Africa", "Africa/Johannesburg", -29.0927, 26.3024],
  ["BFS", "Belfast International Airport", "Belfast", "United Kingdom", "Europe/London", 54.6575, -6.2158],
  ["BGF", "Bangui M'Poko International Airport", "Bangui", "Central African Republic", "Africa/Bangui", 4.3985, 18.5188],
  ["BGI", "Grantley Adams International Airport", "Bridgetown", "Barbados", "America/Barbados", 13.0747, -59.4910],
  ["BGO", "Bergen Airport, Flesland", "Bergen", "Norway", "Europe/Oslo", 60.2934, 5.2181],
  ["BGW", "Baghdad International Airport / New Al Muthana Air Base", "Baghdad", "Iraq", "Asia/Baghdad", 33.2625, 44.2346],
  ["BGY", "Il Caravaggio International Airport", "Bergamo", "Italy", "Europe/Rome", 45.6694, 9.7089, "il caravaggio international airport bergamo bg orio al serio milan"],
  ["BHJ", "Bhuj Airport", "Bhuj", "India", "Asia/Kolkata", 23.2878, 69.6702],
  ["BHK", "Bukhara International Airport", "Bukhara", "Uzbekistan", "Asia/Samarkand", 39.7753, 64.4823],
  ["BHM", "Birmingham-Shuttlesworth International Airport", "Birmingham", "United States", "America/Chicago", 33.5629, -86.7507],
  ["BHO", "Raja Bhoj International Airport", "Bhopal", "India", "Asia/Kolkata", 23.2875, 77.3374],
  ["BHU", "Bhavnagar Airport", "Bhavnagar", "India", "Asia/Kolkata", 21.7522, 72.1852],
  ["BHX", "Birmingham Airport", "Birmingham", "United Kingdom", "Europe/London", 52.4539, -1.7480, "birmingham airport birmingham west midlands"],
  ["BIA", "Bastia-Poretta International airport", "Bastia", "France", "Europe/Paris", 42.5527, 9.4837],
  ["BIO", "Bilbao Airport", "Bilbao", "Spain", "Europe/Madrid", 43.3011, -2.9106],
  ["BJA", "Soummam–Abane Ramdane Airport", "Béjaïa", "Algeria", "Africa/Algiers", 36.7125, 5.0699, "soummam abane ramdane airport béjaïa soummam abane ramdane airport bejaia"],
  ["BJL", "Banjul International Airport", "Banjul", "Gambia", "Africa/Banjul", 13.3380, -16.6522, "banjul international airport banjul yundum"],
  ["BJM", "Bujumbura Melchior Ndadaye International Airport", "Bujumbura", "Burundi", "Africa/Bujumbura", -3.3240, 29.3185],
  ["BJV", "Milas Bodrum International Airport", "Bodrum", "Turkey", "Europe/Istanbul", 37.2493, 27.6640],
  ["BJX", "Guanajuato International Airport", "Silao", "Mexico", "America/Mexico_City", 20.9927, -101.4803],
  ["BKI", "Kota Kinabalu International Airport", "Kota Kinabalu", "Malaysia", "Asia/Kuching", 5.9327, 116.0493],
  ["BKK", "Suvarnabhumi Airport", "Bangkok", "Thailand", "Asia/Bangkok", 13.6811, 100.7470],
  ["BKO", "Modibo Keita International Airport", "Bamako", "Mali", "Africa/Bamako", 12.5335, -7.9499],
  ["BLA", "General José Antonio Anzoategui International Airport", "Barcelona", "Venezuela", "America/Caracas", 10.1111, -64.6922, "general josé antonio anzoategui international airport barcelona general jose antonio anzoategui international airport barcelona"],
  ["BLJ", "Batna Mostefa Ben Boulaid Airport", "Batna", "Algeria", "Africa/Algiers", 35.7521, 6.3086],
  ["BLL", "Billund Airport", "Billund", "Denmark", "Europe/Copenhagen", 55.7403, 9.1570],
  ["BLQ", "Bologna Guglielmo Marconi Airport", "Bologna", "Italy", "Europe/Rome", 44.5354, 11.2887],
  ["BLR", "Kempegowda International Airport Bengaluru", "Bengaluru", "India", "Asia/Kolkata", 13.1979, 77.7063, "kempegowda international airport bengaluru bengaluru bangalore"],
  ["BLZ", "Chileka International Airport", "Blantyre", "Malawi", "Africa/Blantyre", -15.6772, 34.9723],
  ["BME", "Broome International Airport", "Broome", "Australia", "Australia/Perth", -17.9492, 122.2283],
  ["BNA", "Nashville International Airport", "Nashville", "United States", "America/Chicago", 36.1245, -86.6782],
  ["BND", "Bandar Abbas International Airport", "Bandar Abbas", "Iran", "Asia/Tehran", 27.2183, 56.3778],
  ["BNE", "Brisbane International Airport", "Brisbane", "Australia", "Australia/Brisbane", -27.3842, 153.1170],
  ["BNX", "Banja Luka International Airport", "Mahovljani", "Bosnia and Herzegovina", "Europe/Sarajevo", 44.9414, 17.2975],
  ["BOD", "Bordeaux–Mérignac Airport", "Bordeaux", "France", "Europe/Paris", 44.8287, -0.7154, "bordeaux mérignac airport bordeaux bordeaux merignac airport bordeaux"],
  ["BOG", "El Dorado International Airport", "Bogota", "Colombia", "America/Bogota", 4.7016, -74.1469],
  ["BOI", "Boise Air Terminal/Gowen Field", "Boise", "United States", "America/Boise", 43.5644, -116.2230],
  ["BOJ", "Burgas Airport", "Burgas", "Bulgaria", "Europe/Sofia", 42.5699, 27.5152],
  ["BOM", "Chhatrapati Shivaji Maharaj International Airport", "Mumbai", "India", "Asia/Kolkata", 19.0887, 72.8679, "chhatrapati shivaji maharaj international airport mumbai bombay"],
  ["BON", "Flamingo International Airport", "Kralendijk", "Caribbean Netherlands", "America/Kralendijk", 12.1310, -68.2685],
  ["BOO", "Bodø Airport", "Bodø", "Norway", "Europe/Oslo", 67.2692, 14.3653],
  ["BOS", "Boston Logan International Airport", "Boston", "United States", "America/New_York", 42.3620, -71.0079],
  ["BOY", "Bobo Dioulasso Airport", "Bobo Dioulasso", "Burkina Faso", "Africa/Ouagadougou", 11.1601, -4.3310],
  ["BPN", "Sultan Aji Muhammad Sulaiman Sepinggan International Airport", "Balikpapan", "Indonesia", "Asia/Makassar", -1.2683, 116.8945],
  ["BPS", "Porto Seguro International Airport", "Porto Seguro", "Brazil", "America/Bahia", -16.4384, -39.0806],
  ["BQT", "Brest International Airport", "Brest", "Belarus", "Europe/Minsk", 52.1081, 23.8968],
  ["BRC", "Teniente Luis Candelaria International Airport", "San Carlos de Bariloche", "Argentina", "America/Argentina/Salta", -41.1512, -71.1575],
  ["BRE", "Bremen Airport", "Bremen", "Germany", "Europe/Berlin", 53.0468, 8.7893],
  ["BRI", "Bari Karol Wojtyła International Airport", "Bari", "Italy", "Europe/Rome", 41.1389, 16.7606],
  ["BRM", "Jacinto Lara International Airport", "Barquisimeto", "Venezuela", "America/Caracas", 10.0427, -69.3586],
  ["BRS", "Bristol Airport", "Bristol", "United Kingdom", "Europe/London", 51.3823, -2.7165],
  ["BRU", "Brussels Airport", "Brussels", "Belgium", "Europe/Brussels", 50.9014, 4.4844, "brussels airport brussels zaventem"],
  ["BSA", "Bender Qassim International Airport", "Bosaso", "Somalia", "Africa/Mogadishu", 11.2752, 49.1392],
  ["BSB", "Presidente Juscelino Kubitschek International Airport", "Brasília", "Brazil", "America/Sao_Paulo", -15.8692, -47.9208, "presidente juscelino kubitschek international airport brasília presidente juscelino kubitschek international airport brasilia"],
  ["BSG", "Bata International Airport", "Bata", "Equatorial Guinea", "Africa/Malabo", 1.9055, 9.8057],
  ["BSK", "Biskra - Mohamed Khider Airport", "Biskra", "Algeria", "Africa/Algiers", 34.7932, 5.7389],
  ["BSL", "EuroAirport Basel–Mulhouse–Freiburg", "Bâle / Mulhouse", "France", "Europe/Paris", 47.6007, 7.5211, "euroairport basel mulhouse freiburg bâle mulhouse euroairport basel mulhouse freiburg bale mulhouse"],
  ["BSR", "Basra International Airport", "Basra", "Iraq", "Asia/Baghdad", 30.5491, 47.6621],
  ["BSZ", "Manas International Airport", "Bishkek", "Kyrgyzstan", "Asia/Bishkek", 43.0613, 74.4776],
  ["BTH", "Hang Nadim International Airport", "Batam", "Indonesia", "Asia/Jakarta", 1.1210, 104.1190],
  ["BTJ", "Sultan Iskandar Muda International Airport", "Banda Aceh", "Indonesia", "Asia/Jakarta", 5.5251, 95.4200],
  ["BTS", "M. R. Štefánik Airport", "Bratislava", "Slovakia", "Europe/Bratislava", 48.1702, 17.2127, "m r štefánik airport bratislava m r stefanik airport bratislava"],
  ["BUD", "Budapest Liszt Ferenc International Airport", "Budapest", "Hungary", "Europe/Budapest", 47.4302, 19.2624],
  ["BUF", "Buffalo Niagara International Airport", "Buffalo", "United States", "America/New_York", 42.9405, -78.7322],
  ["BUP", "Bathinda Airport", "Bathinda", "India", "Asia/Kolkata", 30.2701, 74.7558, "bathinda airport bathinda bhatinda"],
  ["BUQ", "Joshua Mqabuko Nkomo International Airport", "Bulawayo", "Zimbabwe", "Africa/Harare", -20.0163, 28.6229],
  ["BUR", "Hollywood Burbank/Bob Hope Airport", "Burbank", "United States", "America/Los_Angeles", 34.2028, -118.3581],
  ["BUS", "Alexander Kartveli Batumi International Airport", "Batumi", "Georgia", "Asia/Tbilisi", 41.6094, 41.6003],
  ["BVA", "Beauvais-Tillé airport", "Beauvais", "France", "Europe/Paris", 49.4544, 2.1128, "beauvais tillé airport beauvais paris beauvais tille airport beauvais paris"],
  ["BVB", "Atlas Brasil Cantanhede International Airport", "Boa Vista", "Brazil", "America/Boa_Vista", 2.8462, -60.6906],
  ["BVC", "Aristides Pereira International Airport", "Rabil", "Cape Verde", "Atlantic/Cape_Verde", 16.1365, -22.8889],
  ["BWA", "Gautam Buddha International Airport", "Siddharthanagar", "Nepal", "Asia/Kathmandu", 27.5046, 83.4104, "gautam buddha international airport siddharthanagar bhairahawa"],
  ["BWI", "Baltimore/Washington International Thurgood Marshall Airport", "Baltimore", "United States", "America/New_York", 39.1754, -76.6683],
  ["BWN", "Brunei International Airport", "Bandar Seri Begawan", "Brunei", "Asia/Brunei", 4.9442, 114.9280],
  ["BXY", "Baikonur Krayniy International Airport", "Baikonur", "Kazakhstan", "Asia/Qyzylorda", 45.6220, 63.2108],
  ["BZE", "Philip S. W. Goldson International Airport", "Belize City", "Belize", "America/Belize", 17.5400, -88.3036],
  ["BZV", "Maya-Maya International Airport", "Brazzaville", "Republic of the Congo", "Africa/Brazzaville", -4.2517, 15.2530],
  ["CAG", "Cagliari Elmas Airport", "Cagliari", "Italy", "Europe/Rome", 39.2515, 9.0543],
  ["CAI", "Cairo International Airport", "Cairo", "Egypt", "Africa/Cairo", 30.1115, 31.3967],
  ["CAN", "Guangzhou Baiyun International Airport", "Guangzhou", "China", "Asia/Shanghai", 23.3924, 113.2990, "guangzhou baiyun international airport guangzhou huadu"],
  ["CAP", "Cap Haitien International Airport", "Cap Haitien", "Haiti", "America/Port-au-Prince", 19.7255, -72.2007],
  ["CAY", "Cayenne – Félix Eboué Airport", "Matoury", "French Guiana", "America/Cayenne", 4.8200, -52.3613, "cayenne félix eboué airport matoury cayenne felix eboue airport matoury"],
  ["CBB", "Jorge Wilsterman International Airport", "Cochabamba", "Bolivia", "America/La_Paz", -17.4211, -66.1771],
  ["CCJ", "Calicut International Airport", "Calicut", "India", "Asia/Kolkata", 11.1360, 75.9552],
  ["CCK", "Cocos (Keeling) Islands Airport", "West Island", "Cocos (Keeling) Islands", "Indian/Cocos", -12.1922, 96.8341],
  ["CCP", "Carriel Sur International Airport", "Concepcion", "Chile", "America/Santiago", -36.7724, -73.0628],
  ["CCS", "Maiquetía Simón Bolívar International Airport", "Maiquetía", "Venezuela", "America/Caracas", 10.6022, -66.9912, "maiquetía simón bolívar international airport maiquetía maiquetia simon bolivar international airport maiquetia"],
  ["CCU", "Netaji Subhash Chandra Bose International Airport", "Kolkata", "India", "Asia/Kolkata", 22.6540, 88.4476, "netaji subhash chandra bose international airport kolkata calcutta kalkutta"],
  ["CDG", "Charles de Gaulle International Airport", "Paris", "France", "Europe/Paris", 49.0090, 2.5541, "charles de gaulle international airport paris roissy en france val d oise"],
  ["CDP", "Kadapa Airport", "Kadapa", "India", "Asia/Kolkata", 14.5132, 78.7692],
  ["CEB", "Mactan Cebu International Airport", "Cebu City/Lapu-Lapu City", "Philippines", "Asia/Manila", 10.3093, 123.9797],
  ["CEI", "Mae Fah Luang - Chiang Rai International Airport", "Chiang Rai", "Thailand", "Asia/Bangkok", 19.9523, 99.8829],
  ["CEK", "Kurchatov Chelyabinsk International Airport", "Chelyabinsk", "Russia", "Asia/Yekaterinburg", 55.3031, 61.5049],
  ["CFE", "Clermont-Ferrand Auvergne airport", "Clermont-Ferrand", "France", "Europe/Paris", 45.7867, 3.1692],
  ["CFK", "Chlef Aboubakr Belkaid International Airport", "Chlef", "Algeria", "Africa/Algiers", 36.2166, 1.3411],
  ["CFU", "Corfu Ioannis Kapodistrias International Airport", "Kerkyra", "Greece", "Europe/Athens", 39.6014, 19.9122],
  ["CGB", "Várzea Grande–Marechal Rondon International Airport", "Cuiabá", "Brazil", "America/Cuiaba", -15.6529, -56.1167, "várzea grande marechal rondon international airport cuiabá varzea grande marechal rondon international airport cuiaba"],
  ["CGH", "Congonhas–Deputado Freitas Nobre Airport", "São Paulo", "Brazil", "America/Sao_Paulo", -23.6277, -46.6546, "congonhas deputado freitas nobre airport são paulo sao congonhas deputado freitas nobre airport sao paulo sao"],
  ["CGK", "Soekarno-Hatta International Airport", "Jakarta", "Indonesia", "Asia/Jakarta", -6.1256, 106.6560],
  ["CGN", "Cologne Bonn Airport", "Köln", "Germany", "Europe/Berlin", 50.8659, 7.1427, "cologne bonn airport köln cologne bonn airport koln"],
  ["CGO", "Zhengzhou Xinzheng International Airport", "Zhengzhou", "China", "Asia/Shanghai", 34.5265, 113.8492],
  ["CGP", "Shah Amanat International Airport", "Chattogram", "Bangladesh", "Asia/Dhaka", 22.2496, 91.8133, "shah amanat international airport chattogram chittagong"],
  ["CGQ", "Changchun Longjia International Airport", "Changchun", "China", "Asia/Shanghai", 43.9962, 125.6850],
  ["CGY", "Laguindingan International Airport", "Laguindingan", "Philippines", "Asia/Manila", 8.6122, 124.4565],
  ["CHC", "Christchurch International Airport", "Christchurch", "New Zealand", "Pacific/Auckland", -43.4890, 172.5321],
  ["CHQ", "Chania International Airport", "Souda", "Greece", "Europe/Athens", 35.5312, 24.1507],
  ["CHS", "Charleston International Airport", "Charleston", "United States", "America/New_York", 32.8962, -80.0382],
  ["CIA", "Ciampino–G. B. Pastine International Airport", "Rome", "Italy", "Europe/Rome", 41.7988, 12.5953],
  ["CIT", "Shymkent International Airport", "Shymkent", "Kazakhstan", "Asia/Almaty", 42.3650, 69.4756],
  ["CIX", "Capitán FAP José A. Quiñones González International Airport", "Chiclayo", "Peru", "America/Lima", -6.7892, -79.8283, "capitán fap josé a quiñones gonzález international airport chiclayo capitan fap jose a quinones gonzalez international airport chiclayo"],
  ["CJB", "Coimbatore International Airport", "Coimbatore", "India", "Asia/Kolkata", 11.0300, 77.0434],
  ["CJJ", "Cheongju International Airport/Cheongju Air Base (K-59/G-513)", "Cheongju", "South Korea", "Asia/Seoul", 36.7156, 127.5003],
  ["CJS", "Abraham González International Airport", "Ciudad Juárez", "Mexico", "America/Ciudad_Juarez", 31.6367, -106.4285, "abraham gonzález international airport ciudad juárez abraham gonzalez international airport ciudad juarez"],
  ["CJU", "Jeju International Airport", "Jeju City", "South Korea", "Asia/Seoul", 33.5121, 126.4925],
  ["CKG", "Chongqing Jiangbei International Airport", "Chongqing", "China", "Asia/Shanghai", 29.7123, 106.6519],
  ["CKY", "Ahmed Sékou Touré International Airport", "Conakry", "Guinea", "Africa/Conakry", 9.5769, -13.6120, "ahmed sékou touré international airport conakry ahmed sekou toure international airport conakry"],
  ["CLE", "Cleveland Hopkins International Airport", "Cleveland", "United States", "America/New_York", 41.4117, -81.8498],
  ["CLJ", "Avram Iancu Cluj International Airport", "Cluj-Napoca", "Romania", "Europe/Bucharest", 46.7860, 23.6857],
  ["CLO", "Alfonso Bonilla Aragon International Airport", "Cali", "Colombia", "America/Bogota", 3.5427, -76.3819],
  ["CLT", "Charlotte Douglas International Airport", "Charlotte", "United States", "America/New_York", 35.2140, -80.9431],
  ["CMB", "Bandaranaike International Colombo Airport", "Colombo", "Sri Lanka", "Asia/Colombo", 7.1808, 79.8841],
  ["CMH", "John Glenn Columbus International Airport", "Columbus", "United States", "America/New_York", 39.9980, -82.8919],
  ["CMN", "Mohammed V International Airport", "Casablanca", "Morocco", "Africa/Casablanca", 33.3675, -7.5900],
  ["CMW", "Ignacio Agramonte International Airport", "Camaguey", "Cuba", "America/Havana", 21.4199, -77.8480],
  ["CND", "Mihail Kogălniceanu International Airport", "Constanța", "Romania", "Europe/Bucharest", 44.3622, 28.4883, "mihail kogălniceanu international airport constanța mihail kogalniceanu international airport constanta"],
  ["CNF", "Tancredo Neves International Airport", "Belo Horizonte", "Brazil", "America/Sao_Paulo", -19.6357, -43.9669],
  ["CNN", "Kannur International Airport", "Kannur", "India", "Asia/Kolkata", 11.9163, 75.5450],
  ["CNS", "Cairns International Airport", "Cairns", "Australia", "Australia/Brisbane", -16.8789, 145.7495],
  ["CNX", "Chiang Mai International Airport", "Chiang Mai", "Thailand", "Asia/Bangkok", 18.7668, 98.9626],
  ["COK", "Cochin International Airport", "Kochi", "India", "Asia/Kolkata", 10.1510, 76.4008],
  ["COO", "Cotonou Cadjehoun International Airport", "Cotonou", "Benin", "Africa/Porto-Novo", 6.3572, 2.3843],
  ["COR", "Ingeniero Aeronáutico Ambrosio L.V. Taravella International Airport", "Cordoba", "Argentina", "America/Argentina/Cordoba", -31.3123, -64.2083, "ingeniero aeronáutico ambrosio l v taravella international airport cordoba ingeniero aeronautico ambrosio l v taravella international airport cordoba"],
  ["COS", "City of Colorado Springs Municipal Airport", "Colorado Springs", "United States", "America/Denver", 38.8058, -104.7010],
  ["COV", "Çukurova International Airport", "Tarsus", "Turkey", "Europe/Istanbul", 36.8915, 35.0712, "çukurova international airport tarsus cukurova international airport tarsus"],
  ["CPH", "Copenhagen Kastrup Airport", "Copenhagen", "Denmark", "Europe/Copenhagen", 55.6179, 12.6560],
  ["CPT", "Cape Town International Airport", "Cape Town", "South Africa", "Africa/Johannesburg", -33.9740, 18.6043],
  ["CRA", "Craiova International Airport", "Craiova", "Romania", "Europe/Bucharest", 44.3181, 23.8886],
  ["CRD", "General Enrique Mosconi International Airport", "Comodoro Rivadavia", "Argentina", "America/Argentina/Catamarca", -45.7869, -67.4634],
  ["CRK", "Clark International Airport / Clark Air Base", "Mabalacat", "Philippines", "Asia/Manila", 15.1860, 120.5600],
  ["CRL", "Brussels South Charleroi Airport", "Charleroi", "Belgium", "Europe/Brussels", 50.4620, 4.4596],
  ["CRZ", "Türkmenabat International Airport", "Türkmenabat", "Turkmenistan", "Asia/Ashgabat", 38.9307, 63.5640, "türkmenabat international airport türkmenabat turkmenabat international airport turkmenabat"],
  ["CSX", "Changsha Huanghua International Airport", "Changsha", "China", "Asia/Shanghai", 28.1892, 113.2200],
  ["CTA", "Catania-Fontanarossa Airport", "Catania", "Italy", "Europe/Rome", 37.4668, 15.0664],
  ["CTG", "Rafael Nuñez International Airport", "Cartagena", "Colombia", "America/Bogota", 10.4424, -75.5130, "rafael nuñez international airport cartagena rafael nunez international airport cartagena"],
  ["CTS", "New Chitose Airport", "Sapporo", "Japan", "Asia/Tokyo", 42.7748, 141.6904],
  ["CTU", "Chengdu Shuangliu International Airport", "Chengdu", "China", "Asia/Shanghai", 30.5583, 103.9460],
  ["CUL", "Bachigualato Federal International Airport", "Culiacán", "Mexico", "America/Mazatlan", 24.7650, -107.4752, "bachigualato federal international airport culiacán bachigualato federal international airport culiacan"],
  ["CUN", "Cancún International Airport", "Cancún", "Mexico", "America/Cancun", 21.0408, -86.8735, "cancún international airport cancún cancun international airport cancun"],
  ["CUR", "Hato International Airport", "Willemstad", "Curaçao", "America/Curacao", 12.1889, -68.9598],
  ["CUU", "General Roberto Fierro Villalobos International Airport", "Chihuahua", "Mexico", "America/Chihuahua", 28.7026, -105.9638],
  ["CUZ", "Alejandro Velasco Astete International Airport", "Cusco", "Peru", "America/Lima", -13.5357, -71.9388],
  ["CVG", "Cincinnati Northern Kentucky International Airport", "Cincinnati / Covington", "United States", "America/New_York", 39.0488, -84.6678],
  ["CWB", "Curitiba-Afonso Pena International Airport", "Curitiba", "Brazil", "America/Sao_Paulo", -25.5285, -49.1758],
  ["CWL", "Cardiff International Airport", "Cardiff", "United Kingdom", "Europe/London", 51.3967, -3.3433],
  ["CXI", "Cassidy International Airport", "Kiritimati", "Kiribati", "Pacific/Kiritimati", 1.9863, -157.3500],
  ["CXR", "Cam Ranh International Airport / Cam Ranh Air Base", "Nha Trang/nha Trang aiurportCam Ranh", "Vietnam", "Asia/Ho_Chi_Minh", 11.9982, 109.2190],
  ["CZL", "Mohamed Boudiaf International Airport", "Constantine", "Algeria", "Africa/Algiers", 36.2760, 6.6204],
  ["CZM", "Cozumel International Airport", "Cozumel", "Mexico", "America/Cancun", 20.5149, -86.9285],
  ["DAC", "Hazrat Shahjalal International Airport", "Dhaka", "Bangladesh", "Asia/Dhaka", 23.8433, 90.3978],
  ["DAD", "Da Nang International Airport", "Da Nang", "Vietnam", "Asia/Ho_Chi_Minh", 16.0439, 108.1990],
  ["DAL", "Dallas Love Field", "Dallas", "United States", "America/Chicago", 32.8448, -96.8477],
  ["DAM", "Damascus International Airport", "Damascus", "Syria", "Asia/Damascus", 33.4115, 36.5156],
  ["DAR", "Julius Nyerere International Airport", "Dar es Salaam", "Tanzania", "Africa/Dar_es_Salaam", -6.8735, 39.2073],
  ["DAT", "Datong Yungang International Airport", "Datong", "China", "Asia/Shanghai", 40.0614, 113.4805],
  ["DBB", "El Alamein International Airport", "El Alamein", "Egypt", "Africa/Cairo", 30.9243, 28.4616],
  ["DBR", "Darbhanga Airport", "Darbhanga", "India", "Asia/Kolkata", 26.1928, 85.9169],
  ["DBV", "Dubrovnik Ruđer Bošković Airport", "Dubrovnik", "Croatia", "Europe/Zagreb", 42.5622, 18.2655, "dubrovnik ruđer bošković airport dubrovnik dubrovnik ruđer boskovic airport dubrovnik"],
  ["DCA", "Ronald Reagan Washington National Airport", "Washington", "United States", "America/New_York", 38.8521, -77.0377],
  ["DEB", "Debrecen International Airport", "Debrecen", "Hungary", "Europe/Budapest", 47.4895, 21.6163],
  ["DED", "Dehradun Jolly Grant Airport", "Dehradun", "India", "Asia/Kolkata", 30.1892, 78.1767, "dehradun jolly grant airport dehradun jauligrant"],
  ["DEL", "Indira Gandhi International Airport", "New Delhi", "India", "Asia/Kolkata", 28.5556, 77.0952, "indira gandhi international airport new delhi deli"],
  ["DEN", "Denver International Airport", "Denver", "United States", "America/Denver", 39.8600, -104.6738],
  ["DFW", "Dallas Fort Worth International Airport", "Dallas-Fort Worth", "United States", "America/Chicago", 32.8968, -97.0380],
  ["DGH", "Deoghar Airport", "Deoghar", "India", "Asia/Kolkata", 24.4468, 86.7050],
  ["DHM", "Kangra Airport", "Dharamshala", "India", "Asia/Kolkata", 32.1649, 76.2630, "kangra airport kangra dharamshala dharamsala daramsala"],
  ["DIA", "Doha International Airport", "Doha", "Qatar", "Asia/Qatar", 25.2594, 51.5655],
  ["DIB", "Dibrugarh Airport", "Dibrugarh", "India", "Asia/Kolkata", 27.4839, 95.0169],
  ["DIL", "Presidente Nicolau Lobato International Airport", "Dili", "Timor-Leste", "Asia/Dili", -8.5466, 125.5245],
  ["DIR", "Aba Tenna Dejazmach Yilma International Airport", "Dire Dawa", "Ethiopia", "Africa/Addis_Ababa", 9.6235, 41.8550],
  ["DIU", "Diu Airport", "Diu", "India", "Asia/Kolkata", 20.7142, 70.9219],
  ["DJE", "Djerba Zarzis International Airport", "Mellita", "Tunisia", "Africa/Tunis", 33.8737, 10.7773],
  ["DJG", "Tiska Djanet Airport", "Djanet", "Algeria", "Africa/Algiers", 24.2854, 9.4637],
  ["DJJ", "Dortheys Hiyo Eluay International Airport", "Sentani", "Indonesia", "Asia/Jayapura", -2.5796, 140.5199],
  ["DJT", "President Donald J. Trump International Airport", "West Palm Beach", "United States", "America/New_York", 26.6832, -80.0956],
  ["DLA", "Douala International Airport", "Douala", "Cameroon", "Africa/Douala", 4.0061, 9.7195],
  ["DLC", "Dalian Zhoushuizi International Airport", "Dalian", "China", "Asia/Shanghai", 38.9657, 121.5385, "dalian zhoushuizi international airport dalian ganjingzi"],
  ["DLM", "Dalaman International Airport", "Dalaman", "Turkey", "Europe/Istanbul", 36.7131, 28.7925],
  ["DMB", "Taraz International Airport", "Taraz", "Kazakhstan", "Asia/Almaty", 42.8536, 71.3036],
  ["DME", "Domodedovo International Airport", "Moscow", "Russia", "Europe/Moscow", 55.4088, 37.9063],
  ["DMK", "Don Mueang International Airport", "Bangkok", "Thailand", "Asia/Bangkok", 13.9126, 100.6070],
  ["DMM", "King Fahd International Airport", "Ad Dammam", "Saudi Arabia", "Asia/Riyadh", 26.4691, 49.7982],
  ["DMU", "Dimapur Airport", "Dimapur", "India", "Asia/Kolkata", 25.8839, 93.7711],
  ["DNH", "Dunhuang Mogao International Airport", "Dunhuang", "China", "Asia/Shanghai", 40.1620, 94.8128],
  ["DOH", "Hamad International Airport", "Doha", "Qatar", "Asia/Qatar", 25.2731, 51.6081],
  ["DPS", "Denpasar I Gusti Ngurah Rai International Airport", "Denpasar", "Indonesia", "Asia/Makassar", -8.7484, 115.1671, "denpasar i gusti ngurah rai international airport denpasar badung kuta bali"],
  ["DQM", "Duqm International Airport", "Duqm", "Oman", "Asia/Muscat", 19.5019, 57.6342],
  ["DRP", "Bicol International Airport", "Legazpi", "Philippines", "Asia/Manila", 13.1119, 123.6768],
  ["DRS", "Dresden Airport", "Dresden", "Germany", "Europe/Berlin", 51.1341, 13.7678],
  ["DRW", "Darwin International Airport / RAAF Darwin", "Darwin", "Australia", "Australia/Darwin", -12.4150, 130.8818],
  ["DSM", "Des Moines International Airport", "Des Moines", "United States", "America/Chicago", 41.5340, -93.6567],
  ["DSN", "Ordos Ejin Horo International Airport", "Ordos", "China", "Asia/Shanghai", 39.4935, 109.8599],
  ["DSS", "Blaise Diagne International Airport", "Dakar", "Senegal", "Africa/Dakar", 14.6709, -17.0728],
  ["DSY", "Dara Sakor International Airport", "Ta Noun", "Cambodia", "Asia/Phnom_Penh", 10.9142, 103.2267],
  ["DTM", "Dortmund Airport", "Dortmund", "Germany", "Europe/Berlin", 51.5183, 7.6122],
  ["DTW", "Detroit Metropolitan Wayne County Airport", "Detroit", "United States", "America/Detroit", 42.2138, -83.3538],
  ["DUB", "Dublin Airport", "Dublin", "Ireland", "Europe/Dublin", 53.4287, -6.2621],
  ["DUR", "King Shaka International Airport", "Durban", "South Africa", "Africa/Johannesburg", -29.6144, 31.1197],
  ["DUS", "Düsseldorf Airport", "Düsseldorf", "Germany", "Europe/Berlin", 51.2895, 6.7668, "düsseldorf airport düsseldorf dusseldorf airport dusseldorf"],
  ["DVO", "Francisco Bangoy International Airport", "Davao", "Philippines", "Asia/Manila", 7.1255, 125.6460],
  ["DWC", "Al Maktoum International Airport", "Dubai", "United Arab Emirates", "Asia/Dubai", 24.8962, 55.1624, "al maktoum international airport dubai jebel ali"],
  ["DXB", "Dubai International Airport", "Dubai", "United Arab Emirates", "Asia/Dubai", 25.2498, 55.3710],
  ["DXN", "Noida International Airport", "Noida", "India", "Asia/Kolkata", 28.1799, 77.6118, "noida international airport noida gautam buddha nagar jewar"],
  ["DYG", "Zhangjiajie Hehua International Airport", "Zhangjiajie", "China", "Asia/Shanghai", 29.1047, 110.4428, "zhangjiajie hehua international airport zhangjiajie yongding"],
  ["DYU", "Dushanbe International Airport", "Dushanbe", "Tajikistan", "Asia/Dushanbe", 38.5437, 68.8230],
  ["DZA", "Dzaoudzi Pamandzi International Airport", "Dzaoudzi", "Mayotte", "Indian/Mayotte", -12.8093, 45.2818],
  ["DZN", "Zhezkazgan National Airport", "Zhezkazgan", "Kazakhstan", "Asia/Almaty", 47.7090, 67.7381],
  ["EBB", "Entebbe International Airport", "Entebbe", "Uganda", "Africa/Kampala", 0.0424, 32.4435],
  ["EBL", "Erbil International Airport", "Arbil", "Iraq", "Asia/Baghdad", 36.2360, 43.9466],
  ["ECN", "Ercan International Airport", "Tymbou", "Cyprus", "Asia/Famagusta", 35.1531, 33.5074, "ercan international airport tymbou kirklar"],
  ["EDI", "Edinburgh Airport", "Edinburgh", "United Kingdom", "Europe/London", 55.9501, -3.3723, "edinburgh airport edinburgh ingliston"],
  ["EDL", "Eldoret International Airport", "Eldoret", "Kenya", "Africa/Nairobi", 0.4045, 35.2389],
  ["EDO", "Balıkesir Koca Seyit Airport", "Edremit", "Turkey", "Europe/Istanbul", 39.5525, 27.0102],
  ["EHU", "Ezhou Huahu International Airport", "Ezhou", "China", "Asia/Shanghai", 30.3412, 115.0393],
  ["EIN", "Eindhoven Airport", "Eindhoven", "Netherlands", "Europe/Amsterdam", 51.4501, 5.3745],
  ["EIS", "Terrance B. Lettsome International Airport", "Beef Island", "British Virgin Islands", "America/Tortola", 18.4455, -64.5417],
  ["ELP", "El Paso International Airport", "El Paso", "United States", "America/Denver", 31.8099, -106.3756],
  ["ELQ", "Prince Naif bin Abdulaziz International Airport", "Qassim", "Saudi Arabia", "Asia/Riyadh", 26.3028, 43.7744],
  ["ELS", "King Phalo Airport", "East London", "South Africa", "Africa/Johannesburg", -33.0356, 27.8259],
  ["EMA", "East Midlands Airport", "Nottingham", "United Kingdom", "Europe/London", 52.8311, -1.3281, "east midlands airport nottingham leicestershire"],
  ["ENO", "Teniente Ramon A. Ayub Gonzalez International Airport", "Encarnación", "Paraguay", "America/Asuncion", -27.2275, -55.8376, "teniente ramon a ayub gonzalez international airport encarnación teniente ramon a ayub gonzalez international airport encarnacion"],
  ["ENU", "Akanu Ibiam International Airport", "Enegu", "Nigeria", "Africa/Lagos", 6.4737, 7.5605],
  ["ERF", "Erfurt-Weimar Airport", "Erfurt", "Germany", "Europe/Berlin", 50.9783, 10.9607],
  ["ESB", "Esenboğa International Airport", "Ankara", "Turkey", "Europe/Istanbul", 40.1281, 32.9951, "esenboğa international airport ankara esenboga international airport ankara"],
  ["ESM", "Carlos Concha Torres International Airport", "Tachina", "Ecuador", "America/Guayaquil", 0.9785, -79.6266],
  ["ETM", "Ramon International Airport", "Eilat", "Israel", "Asia/Amman", 29.7270, 35.0141],
  ["EUN", "Laayoune Hassan I International Airport", "El Aaiún", "Western Sahara (disputed territory)", "Africa/El_Aaiun", 27.1425, -13.2249, "laayoune hassan i international airport el aaiún laayoune hassan i international airport el aaiun"],
  ["EVE", "Harstad/Narvik Airport", "Evenes", "Norway", "Europe/Oslo", 68.4913, 16.6781],
  ["EVN", "Zvartnots International Airport", "Yerevan", "Armenia", "Asia/Yerevan", 40.1489, 44.3979],
  ["EWR", "Newark Liberty International Airport", "Newark", "United States", "America/New_York", 40.6894, -74.1705, "newark liberty international airport newark new york"],
  ["EZE", "Ezeiza International Airport - Ministro Pistarini", "Buenos Aires", "Argentina", "America/Argentina/Buenos_Aires", -34.8222, -58.5358],
  ["FAE", "Vágar Airport", "Vágar", "Faroe Islands", "Atlantic/Faroe", 62.0633, -7.2758, "vágar airport vágar vagar airport vagar"],
  ["FAO", "Faro - Gago Coutinho International Airport", "Faro", "Portugal", "Europe/Lisbon", 37.0159, -7.9709],
  ["FAT", "Fresno Yosemite International Airport", "Fresno", "United States", "America/Los_Angeles", 36.7758, -119.7180],
  ["FBM", "Lubumbashi International Airport", "Lubumbashi", "Democratic Republic of the Congo", "Africa/Lubumbashi", -11.5915, 27.5308],
  ["FCO", "Rome–Fiumicino Leonardo da Vinci International Airport", "Rome", "Italy", "Europe/Rome", 41.8045, 12.2520],
  ["FDF", "Martinique Aimé Césaire International Airport", "Fort-de-France", "Martinique", "America/Martinique", 14.5910, -61.0032, "martinique aimé césaire international airport fort de france martinique aime cesaire international airport fort de france"],
  ["FDH", "Bodensee Airport Friedrichshafen", "Friedrichshafen", "Germany", "Europe/Berlin", 47.6713, 9.5115],
  ["FEZ", "Fes Saïss International Airport", "Saïss", "Morocco", "Africa/Casablanca", 33.9273, -4.9780, "fes saïss international airport saïss fes saiss international airport saiss"],
  ["FIH", "Ndjili International Airport", "Kinshasa", "Democratic Republic of the Congo", "Africa/Kinshasa", -4.3857, 15.4446],
  ["FJR", "Fujairah International Airport", "Fujairah", "United Arab Emirates", "Asia/Dubai", 25.1084, 56.3281],
  ["FKB", "Karlsruhe Baden-Baden Airport", "Baden-Baden", "Germany", "Europe/Berlin", 48.7794, 8.0805, "karlsruhe baden baden airport baden baden rheinmünster karlsruhe baden baden airport baden baden rheinmunster"],
  ["FKI", "Bangoka International Airport", "Kisangani", "Democratic Republic of the Congo", "Africa/Lubumbashi", 0.4816, 25.3380],
  ["FLL", "Fort Lauderdale Hollywood International Airport", "Fort Lauderdale", "United States", "America/New_York", 26.0726, -80.1527],
  ["FLN", "Hercílio Luz International Airport", "Florianópolis", "Brazil", "America/Sao_Paulo", -27.6703, -48.5525, "hercílio luz international airport florianópolis hercilio luz international airport florianopolis"],
  ["FLR", "Florence Airport, Peretola", "Firenze", "Italy", "Europe/Rome", 43.8086, 11.2028, "florence airport peretola firenze fi"],
  ["FMM", "Memmingen Allgau Airport", "Memmingen", "Germany", "Europe/Berlin", 47.9881, 10.2382],
  ["FMO", "Münster Osnabrück Airport", "Munster", "Germany", "Europe/Berlin", 52.1338, 7.6885, "münster osnabrück airport munster greven munster osnabruck airport munster greven"],
  ["FNA", "Lungi International Airport", "Freetown", "Sierra Leone", "Africa/Freetown", 8.6164, -13.1955, "lungi international airport freetown town"],
  ["FNC", "Cristiano Ronaldo International Airport", "Funchal", "Portugal", "Atlantic/Madeira", 32.6978, -16.7746],
  ["FNJ", "Pyongyang Sunan International Airport", "Pyongyang", "North Korea", "Asia/Pyongyang", 39.2241, 125.6700],
  ["FOC", "Fuzhou Changle International Airport", "Fuzhou", "China", "Asia/Shanghai", 25.9293, 119.6725],
  ["FOR", "Pinto Martins International Airport", "Fortaleza", "Brazil", "America/Fortaleza", -3.7758, -38.5322],
  ["FPO", "Grand Bahama International Airport", "Freeport", "Bahamas", "America/Nassau", 26.5580, -78.6956],
  ["FRA", "Frankfurt Main Airport", "Frankfurt am Main", "Germany", "Europe/Berlin", 50.0267, 8.5584],
  ["FRW", "Phillip Gaonwe Matante International Airport", "Francistown", "Botswana", "Africa/Gaborone", -21.1592, 27.4688],
  ["FSC", "Figari Sud-Corse Airport", "Figari", "France", "Europe/Paris", 41.5018, 9.0971],
  ["FSZ", "Mount Fuji Shizuoka Airport", "Makinohara / Shimada", "Japan", "Asia/Tokyo", 34.7950, 138.1910],
  ["FUE", "Fuerteventura Airport", "El Matorral", "Spain", "Atlantic/Canary", 28.4527, -13.8638],
  ["FUK", "Fukuoka Airport", "Fukuoka", "Japan", "Asia/Tokyo", 33.5859, 130.4510],
  ["GAN", "Gan International Airport", "Gan", "Maldives", "Indian/Maldives", -0.6930, 73.1526],
  ["GAU", "Lokpriya Gopinath Bordoloi International Airport", "Guwahati", "India", "Asia/Kolkata", 26.1067, 91.5852],
  ["GAY", "Gaya Airport", "Gaya", "India", "Asia/Kolkata", 24.7443, 84.9512, "gaya airport gaya gayya"],
  ["GBE", "Sir Seretse Khama International Airport", "Gaborone", "Botswana", "Africa/Gaborone", -24.5552, 25.9182],
  ["GBI", "Kalaburagi Airport", "Kalaburagi", "India", "Asia/Kolkata", 17.3082, 76.9652, "kalaburagi airport kalaburagi gulbarga"],
  ["GCM", "Owen Roberts International Airport", "George Town", "Cayman Islands", "America/Cayman", 19.2928, -81.3577],
  ["GDB", "Gondia Airport", "Gondia", "India", "Asia/Kolkata", 21.5268, 80.2903],
  ["GDL", "Guadalajara International Airport", "Guadalajara", "Mexico", "America/Mexico_City", 20.5233, -103.3101],
  ["GDN", "Gdańsk Lech Wałęsa Airport", "Gdańsk", "Poland", "Europe/Warsaw", 54.3776, 18.4662, "gdańsk lech wałęsa airport gdańsk gdansk lech wałesa airport gdansk"],
  ["GEG", "Spokane International Airport", "Spokane", "United States", "America/Los_Angeles", 47.6199, -117.5340],
  ["GEO", "Cheddi Jagan International Airport", "Georgetown", "Guyana", "America/Guyana", 6.4985, -58.2541],
  ["GES", "General Santos International Airport", "General Santos", "Philippines", "Asia/Manila", 6.0572, 125.0962],
  ["GHV", "Brașov-Ghimbav International Airport", "Brașov", "Romania", "Europe/Bucharest", 45.7056, 25.5229, "brașov ghimbav international airport brașov brasov ghimbav international airport brasov"],
  ["GIB", "Gibraltar Airport", "Gibraltar", "Gibraltar", "Europe/Gibraltar", 36.1517, -5.3498],
  ["GIG", "Rio Galeão – Tom Jobim International Airport", "Rio de Janeiro", "Brazil", "America/Sao_Paulo", -22.8100, -43.2506, "rio galeão tom jobim international airport rio de janeiro rio galeao tom jobim international airport rio de janeiro"],
  ["GJL", "Jijel Ferhat Abbas Airport", "Tahir", "Algeria", "Africa/Algiers", 36.7941, 5.8737],
  ["GLA", "Glasgow Airport", "Glasgow", "United Kingdom", "Europe/London", 55.8719, -4.4331],
  ["GMP", "Seoul Gimpo International Airport", "Seoul", "South Korea", "Asia/Seoul", 37.5583, 126.7910],
  ["GND", "Maurice Bishop International Airport", "Saint George's", "Grenada", "America/Grenada", 12.0040, -61.7853],
  ["GNJ", "Ganja International Airport", "Ganja", "Azerbaijan", "Asia/Baku", 40.7387, 46.3204],
  ["GNY", "Şanlıurfa GAP Airport", "Şanlıurfa", "Turkey", "Europe/Istanbul", 37.4457, 38.8956, "şanlıurfa gap airport şanlıurfa sanlıurfa gap airport sanlıurfa"],
  ["GOA", "Genoa Cristoforo Colombo Airport", "Genoa", "Italy", "Europe/Rome", 44.4120, 8.8407, "genoa cristoforo colombo airport genoa ge genova"],
  ["GOH", "Nuuk International Airport", "Nuuk", "Greenland", "America/Nuuk", 64.1911, -51.6791],
  ["GOI", "Goa Dabolim International Airport", "Goa", "India", "Asia/Kolkata", 15.3801, 73.8333, "goa dabolim international airport goa vasco da gama"],
  ["GOJ", "Nizhny Novgorod / Strigino International Airport", "Nizhny Novgorod", "Russia", "Europe/Moscow", 56.2274, 43.7852],
  ["GOM", "Goma International Airport", "Goma", "Democratic Republic of the Congo", "Africa/Kigali", -1.6668, 29.2380],
  ["GOP", "Gorakhpur Airport", "Gorakhpur", "India", "Asia/Kolkata", 26.7397, 83.4497],
  ["GOT", "Göteborg Landvetter Airport", "Göteborg", "Sweden", "Europe/Stockholm", 57.6628, 12.2798, "göteborg landvetter airport göteborg gothenburg goteborg landvetter airport goteborg gothenburg"],
  ["GOU", "Garoua International Airport", "Garoua", "Cameroon", "Africa/Douala", 9.3348, 13.3721],
  ["GOX", "Manohar International Airport", "Goa", "India", "Asia/Kolkata", 15.7443, 73.8606, "manohar international airport goa mopa"],
  ["GRJ", "George Airport", "George", "South Africa", "Africa/Johannesburg", -34.0056, 22.3789],
  ["GRO", "Girona-Costa Brava Airport", "Girona", "Spain", "Europe/Madrid", 41.9046, 2.7618],
  ["GRQ", "Groningen Airport Eelde", "Groningen", "Netherlands", "Europe/Amsterdam", 53.1191, 6.5777],
  ["GRR", "Gerald R. Ford International Airport", "Grand Rapids", "United States", "America/Detroit", 42.8808, -85.5228],
  ["GRU", "São Paulo/Guarulhos–Governor André Franco Montoro International Airport", "São Paulo", "Brazil", "America/Sao_Paulo", -23.4313, -46.4700, "são paulo guarulhos governor andré franco montoro international airport são paulo sao sao paulo guarulhos governor andre franco montoro international airport sao paulo sao"],
  ["GRV", "Akhmat Kadyrov Grozny International Airport", "Grozny", "Russia", "Europe/Moscow", 43.3881, 45.6998],
  ["GRZ", "Graz Airport", "Feldkirchen bei Graz", "Austria", "Europe/Vienna", 46.9911, 15.4396],
  ["GSM", "Qeshm International Airport", "Qeshm", "Iran", "Asia/Tehran", 26.7546, 55.9024, "qeshm international airport qeshm dayrestan"],
  ["GSO", "Piedmont Triad International Airport", "Greensboro", "United States", "America/New_York", 36.0994, -79.9373],
  ["GSV", "Gagarin International Airport", "Saratov", "Russia", "Europe/Saratov", 51.7128, 46.1711],
  ["GUA", "La Aurora International Airport", "Guatemala City", "Guatemala", "America/Guatemala", 14.5829, -90.5275],
  ["GUM", "Antonio B. Won Pat International Airport", "Hagåtña", "Guam", "Pacific/Guam", 13.4850, 144.7973, "antonio b won pat international airport hagåtña antonio b won pat international airport hagatna"],
  ["GUW", "Atyrau International Airport", "Atyrau", "Kazakhstan", "Asia/Atyrau", 47.1213, 51.8203],
  ["GVA", "Geneva International Airport", "Geneva", "Switzerland", "Europe/Paris", 46.2381, 6.1090],
  ["GWD", "New Gwadar International Airport", "Gurandani", "Pakistan", "Asia/Karachi", 25.2967, 62.4988],
  ["GWL", "Gwalior Airport", "Gwalior", "India", "Asia/Kolkata", 26.2933, 78.2278],
  ["GXF", "Seiyun Hadhramaut International Airport", "Seiyun", "Yemen", "Asia/Aden", 15.9659, 48.7881],
  ["GYD", "Heydar Aliyev International Airport", "Baku", "Azerbaijan", "Asia/Baku", 40.4728, 50.0509],
  ["GYE", "José Joaquín de Olmedo International Airport", "Guayaquil", "Ecuador", "America/Guayaquil", -2.1574, -79.8836, "josé joaquín de olmedo international airport guayaquil jose joaquin de olmedo international airport guayaquil"],
  ["GYN", "Santa Genoveva International Airport", "Goiânia", "Brazil", "America/Sao_Paulo", -16.6320, -49.2207, "santa genoveva international airport goiânia santa genoveva international airport goiania"],
  ["GZT", "Gaziantep Oğuzeli International Airport", "Gaziantep", "Turkey", "Europe/Istanbul", 36.9472, 37.4787, "gaziantep oğuzeli international airport gaziantep gaziantep oguzeli international airport gaziantep"],
  ["HAH", "Prince Said Ibrahim International Airport", "Moroni", "Comoros", "Indian/Comoro", -11.5337, 43.2719],
  ["HAJ", "Hannover Airport", "Hannover", "Germany", "Europe/Berlin", 52.4611, 9.6851, "hannover airport hannover hanover"],
  ["HAK", "Haikou Meilan International Airport", "Haikou", "China", "Asia/Shanghai", 19.9349, 110.4590],
  ["HAM", "Hamburg Helmut Schmidt Airport", "Hamburg", "Germany", "Europe/Berlin", 53.6304, 9.9882],
  ["HAN", "Noi Bai International Airport", "Hanoi", "Vietnam", "Asia/Bangkok", 21.2212, 105.8070, "noi bai international airport hanoi soc son"],
  ["HAQ", "Hanimaadhoo International Airport", "Haa Dhaalu Atoll", "Maldives", "Indian/Maldives", 6.7432, 73.1671],
  ["HAS", "Hail International Airport", "Hail", "Saudi Arabia", "Asia/Riyadh", 27.4379, 41.6863],
  ["HAV", "José Martí International Airport", "Havana", "Cuba", "America/Havana", 22.9892, -82.4091, "josé martí international airport havana jose marti international airport havana"],
  ["HBA", "Hobart International Airport", "Hobart", "Australia", "Australia/Hobart", -42.8370, 147.5130, "hobart international airport hobart cambridge"],
  ["HBE", "Alexandria International Airport", "Alexandria", "Egypt", "Africa/Cairo", 30.9325, 29.6964],
  ["HBX", "Hubballi Airport", "Hubballi", "India", "Asia/Kolkata", 15.3611, 75.0821, "hubballi airport hubballi hubli"],
  ["HDO", "Hindon Airport", "Ghaziabad", "India", "Asia/Kolkata", 28.7077, 77.3589, "hindon airport ghaziabad hindon air force station"],
  ["HDY", "Hat Yai International Airport", "Hat Yai", "Thailand", "Asia/Bangkok", 6.9332, 100.3930],
  ["HEA", "Herat - Khwaja Abdullah Ansari International Airport", "Guzara", "Afghanistan", "Asia/Kabul", 34.2100, 62.2283],
  ["HEL", "Helsinki Vantaa Airport", "Helsinki", "Finland", "Europe/Helsinki", 60.3184, 24.9633],
  ["HER", "Heraklion International Nikos Kazantzakis Airport", "Heraklion", "Greece", "Europe/Athens", 35.3397, 25.1803],
  ["HET", "Hohhot Baita International Airport", "Hohhot", "China", "Asia/Shanghai", 40.8497, 111.8246],
  ["HFE", "Hefei Xinqiao International Airport", "Hefei", "China", "Asia/Shanghai", 31.9878, 116.9769],
  ["HGA", "Egal International Airport", "Hargeisa", "Somalia", "Africa/Mogadishu", 9.5141, 44.0835],
  ["HGH", "Hangzhou Xiaoshan International Airport", "Hangzhou", "China", "Asia/Shanghai", 30.2361, 120.4289],
  ["HGI", "Itanagar Donyi Polo Hollongi Airport", "Hollongi", "India", "Asia/Kolkata", 26.9668, 93.6388],
  ["HHN", "Frankfurt-Hahn Airport", "Frankfurt am Main", "Germany", "Europe/Berlin", 49.9464, 7.2617, "frankfurt hahn airport frankfurt am main lautzenhausen"],
  ["HIA", "Huai'an Lianshui Airport", "Huai'an", "China", "Asia/Shanghai", 33.7927, 119.1267],
  ["HIJ", "Hiroshima Airport", "Hiroshima", "Japan", "Asia/Tokyo", 34.4361, 132.9190],
  ["HIR", "Honiara International Airport", "Honiara", "Solomon Islands", "Pacific/Guadalcanal", -9.4280, 160.0550],
  ["HJR", "Khajuraho Airport", "Khajuraho", "India", "Asia/Kolkata", 24.8172, 79.9186],
  ["HKD", "Hakodate Airport", "Hakodate", "Japan", "Asia/Tokyo", 41.7700, 140.8220],
  ["HKG", "Hong Kong International Airport", "Hong Kong", "Hong Kong", "Asia/Hong_Kong", 22.3118, 113.9149],
  ["HKT", "Phuket International Airport", "Phuket", "Thailand", "Asia/Bangkok", 8.1133, 98.3174],
  ["HLA", "Lanseria International Airport", "Johannesburg", "South Africa", "Africa/Johannesburg", -25.9390, 27.9266],
  ["HLD", "Hulunbuir Hailar Airport", "Hailar", "China", "Asia/Shanghai", 49.2086, 119.8223],
  ["HLP", "Halim Perdanakusuma International Airport", "Jakarta", "Indonesia", "Asia/Jakarta", -6.2670, 106.8903],
  ["HMB", "Suhaj International Airport", "Suhaj", "Egypt", "Africa/Cairo", 26.3425, 31.7430],
  ["HMO", "General Ignacio L. Pesqueira International Airport", "Hermosillo", "Mexico", "America/Hermosillo", 29.0928, -111.0530],
  ["HND", "Tokyo Haneda International Airport", "Tokyo", "Japan", "Asia/Tokyo", 35.5497, 139.7870],
  ["HNL", "Daniel K. Inouye International Airport", "Honolulu", "United States", "Pacific/Honolulu", 21.3184, -157.9257, "daniel k inouye international airport honolulu oahu"],
  ["HOF", "Al-Ahsa International Airport", "Hofuf", "Saudi Arabia", "Asia/Riyadh", 25.2853, 49.4852],
  ["HOG", "Frank Pais International Airport", "Holguin", "Cuba", "America/Havana", 20.7851, -76.3155],
  ["HOU", "William P. Hobby Airport", "Houston", "United States", "America/Chicago", 29.6453, -95.2768],
  ["HPH", "Cat Bi International Airport", "Haiphong", "Vietnam", "Asia/Bangkok", 20.8174, 106.7243, "cat bi international airport haiphong hai an"],
  ["HRB", "Harbin Taiping International Airport", "Harbin", "China", "Asia/Shanghai", 45.6234, 126.2500],
  ["HRE", "Robert Gabriel Mugabe International Airport", "Harare", "Zimbabwe", "Africa/Harare", -17.9318, 31.0928],
  ["HRG", "Hurghada International Airport", "Hurghada", "Egypt", "Africa/Cairo", 27.1768, 33.7967],
  ["HSA", "Hazrat Sultan International Airport", "Turkıstan", "Kazakhstan", "Asia/Almaty", 43.3111, 68.5504],
  ["HSG", "Kyushu Saga International Airport", "Saga", "Japan", "Asia/Tokyo", 33.1497, 130.3020],
  ["HSN", "Zhoushan Putuoshan International Airport", "Zhoushan", "China", "Asia/Shanghai", 29.9339, 122.3623],
  ["HSR", "Rajkot International Airport", "Rajkot", "India", "Asia/Kolkata", 22.3788, 71.0394, "rajkot international airport rajkot hirasar"],
  ["HSS", "Maharaja Agrasen International Airport", "Hisar", "India", "Asia/Kolkata", 29.1861, 75.7414],
  ["HTA", "Chita-Kadala International Airport", "Chita", "Russia", "Asia/Chita", 52.0248, 113.3058],
  ["HUN", "Hualien Chiashan Airport", "Hualien City", "Taiwan", "Asia/Taipei", 24.0232, 121.6180],
  ["HUX", "Bahías de Huatulco International Airport", "Huatulco", "Mexico", "America/Mexico_City", 15.7754, -96.2605, "bahías de huatulco international airport huatulco bahias de huatulco international airport huatulco"],
  ["HWR", "Halwara International Airport", "Halwara", "India", "Asia/Kolkata", 30.7485, 75.6298],
  ["HYD", "Rajiv Gandhi International Airport", "Hyderabad", "India", "Asia/Kolkata", 17.2313, 78.4299],
  ["IAD", "Washington Dulles International Airport", "Washington", "United States", "America/New_York", 38.9445, -77.4558],
  ["IAH", "George Bush Intercontinental Airport", "Houston", "United States", "America/Chicago", 29.9844, -95.3414],
  ["IAR", "Golden Ring Yaroslavl International Airport", "Tunoshna", "Russia", "Europe/Moscow", 57.5607, 40.1574],
  ["IAS", "Iaşi International Airport", "Iaşi", "Romania", "Europe/Bucharest", 47.1796, 27.6214, "iaşi international airport iaşi iasi international airport iasi"],
  ["IBR", "Ibaraki Airport", "Omitama", "Japan", "Asia/Tokyo", 36.1815, 140.4144],
  ["IBZ", "Ibiza Airport", "Ibiza", "Spain", "Europe/Madrid", 38.8729, 1.3731, "ibiza airport ibiza eivissa"],
  ["ICN", "Incheon International Airport", "Seoul", "South Korea", "Asia/Seoul", 37.4691, 126.4510],
  ["IDR", "Devi Ahilya Bai Holkar International Airport", "Indore", "India", "Asia/Kolkata", 22.7214, 75.8005],
  ["IFN", "Isfahan Shahid Beheshti International Airport", "Isfahan", "Iran", "Asia/Tehran", 32.7551, 51.8839],
  ["IGU", "Cataratas International Airport", "Foz do Iguaçu", "Brazil", "America/Argentina/Cordoba", -25.5942, -54.4894, "cataratas international airport foz do iguaçu cataratas international airport foz do iguacu"],
  ["IKA", "Imam Khomeini International Airport", "Tehran", "Iran", "Asia/Tehran", 35.4161, 51.1522],
  ["IKT", "Irkutsk International Airport", "Irkutsk", "Russia", "Asia/Irkutsk", 52.2667, 104.3956],
  ["IKU", "Issyk-Kul International Airport", "Tamchy", "Kyrgyzstan", "Asia/Bishkek", 42.5856, 76.7012],
  ["ILO", "Iloilo International Airport", "Cabatuan", "Philippines", "Asia/Manila", 10.8330, 122.4934],
  ["ILR", "General Tunde Idiagbon International Airport", "Ilorin/Ogbomosho", "Nigeria", "Africa/Lagos", 8.4402, 4.4939],
  ["IMF", "Bir Tikendrajit International Airport", "Imphal", "India", "Asia/Kolkata", 24.7600, 93.8967],
  ["INC", "Yinchuan Hedong International Airport", "Yinchuan", "China", "Asia/Shanghai", 38.3228, 106.3932],
  ["IND", "Indianapolis International Airport", "Indianapolis", "United States", "America/Indiana/Indianapolis", 39.7173, -86.2944],
  ["INI", "Niš Constantine the Great Airport", "Niš", "Serbia", "Europe/Belgrade", 43.3365, 21.8562, "niš constantine the great airport niš nis constantine the great airport nis"],
  ["INN", "Innsbruck Airport", "Innsbruck", "Austria", "Europe/Vienna", 47.2602, 11.3440],
  ["IOM", "Isle of Man Airport", "Castletown", "Isle of Man", "Europe/Isle_of_Man", 54.0831, -4.6239],
  ["IPC", "Mataveri International Airport", "Isla De Pascua", "Chile", "Pacific/Easter", -27.1654, -109.4210],
  ["IPH", "Sultan Azlan Shah Airport", "Ipoh", "Malaysia", "Asia/Kuala_Lumpur", 4.5673, 101.0916],
  ["IQQ", "Diego Aracena International Airport", "Iquique", "Chile", "America/Santiago", -20.5363, -70.1814],
  ["IQT", "Coronel FAP Francisco Secada Vignetta International Airport", "Iquitos", "Peru", "America/Lima", -3.7847, -73.3088],
  ["ISB", "Islamabad International Airport", "Attock", "Pakistan", "Asia/Karachi", 33.5490, 72.8257],
  ["ISK", "Nashik International Airport", "Nashik", "India", "Asia/Kolkata", 20.1191, 73.9129, "nashik international airport nashik nasik"],
  ["IST", "İstanbul Airport", "Istanbul", "Turkey", "Europe/Istanbul", 41.2749, 28.7321],
  ["ITM", "Osaka Itami International Airport", "Osaka", "Japan", "Asia/Tokyo", 34.7809, 135.4408],
  ["IVL", "Ivalo Airport", "Ivalo", "Finland", "Europe/Helsinki", 68.6073, 27.4053],
  ["IXA", "Agartala - Maharaja Bir Bikram Airport", "Agartala", "India", "Asia/Kolkata", 23.8870, 91.2404],
  ["IXB", "Bagdogra Airport", "Siliguri", "India", "Asia/Kolkata", 26.6812, 88.3286],
  ["IXC", "Shaheed Bhagat Singh International Airport", "Chandigarh", "India", "Asia/Kolkata", 30.6735, 76.7885],
  ["IXD", "Prayagraj Airport", "Allahabad", "India", "Asia/Kolkata", 25.4401, 81.7339],
  ["IXE", "Mangaluru International Airport", "Mangaluru", "India", "Asia/Kolkata", 12.9547, 74.8868, "mangaluru international airport mangaluru mangalore"],
  ["IXG", "Belagavi Airport", "Belgaum", "India", "Asia/Kolkata", 15.8593, 74.6183],
  ["IXI", "Lilabari North Lakhimpur Airport", "Lilabari", "India", "Asia/Kolkata", 27.2957, 94.0973],
  ["IXJ", "Jammu Airport", "Jammu", "India", "Asia/Kolkata", 32.6888, 74.8382],
  ["IXK", "Keshod Airport", "Keshod", "India", "Asia/Kolkata", 21.3171, 70.2704],
  ["IXL", "Leh Kushok Bakula Rimpochee Airport", "Leh", "India", "Asia/Kolkata", 34.1359, 77.5465],
  ["IXM", "Madurai Airport", "Madurai", "India", "Asia/Kolkata", 9.8345, 78.0934],
  ["IXP", "Pathankot Airport", "Pathankot", "India", "Asia/Kolkata", 32.2336, 75.6344],
  ["IXR", "Birsa Munda Airport", "Ranchi", "India", "Asia/Kolkata", 23.3143, 85.3217],
  ["IXS", "Silchar Airport", "Silchar", "India", "Asia/Kolkata", 24.9129, 92.9787],
  ["IXU", "Aurangabad Airport", "Aurangabad", "India", "Asia/Kolkata", 19.8629, 75.3963],
  ["IXY", "Kandla Airport", "Kandla", "India", "Asia/Kolkata", 23.1127, 70.1003],
  ["IXZ", "Veer Savarkar International Airport / INS Utkrosh", "Port Blair", "India", "Asia/Kolkata", 11.6402, 92.7290],
  ["JAF", "Jaffna International Airport", "Jaffna", "Sri Lanka", "Asia/Colombo", 9.7923, 80.0701],
  ["JAI", "Jaipur International Airport", "Jaipur", "India", "Asia/Kolkata", 26.8242, 75.8122],
  ["JAX", "Jacksonville International Airport", "Jacksonville", "United States", "America/New_York", 30.4925, -81.6878],
  ["JCL", "České Budějovice South Bohemian Airport", "České Budějovice", "Czech Republic", "Europe/Prague", 48.9482, 14.4283, "české budějovice south bohemian airport české budějovice ceske budejovice south bohemian airport ceske budejovice"],
  ["JDH", "Jodhpur Airport", "Jodhpur", "India", "Asia/Kolkata", 26.2511, 73.0489],
  ["JED", "King Abdulaziz International Airport", "Jeddah", "Saudi Arabia", "Asia/Riyadh", 21.6802, 39.1574],
  ["JFK", "John F. Kennedy International Airport", "New York", "United States", "America/New_York", 40.6394, -73.7793],
  ["JGA", "Jamnagar Airport", "Jamnagar", "India", "Asia/Kolkata", 22.4655, 70.0126],
  ["JGB", "Jagdalpur Airport", "Jagdalpur", "India", "Asia/Kolkata", 19.0743, 82.0368],
  ["JGN", "Jiayuguan International Airport", "Jiayuguan", "China", "Asia/Shanghai", 39.8591, 98.3393],
  ["JHB", "Senai International Airport", "Johor Bahru", "Malaysia", "Asia/Kuala_Lumpur", 1.6413, 103.6700],
  ["JHG", "Xishuangbanna Gasa International Airport", "Jinghong", "China", "Asia/Shanghai", 21.9746, 100.7622],
  ["JIB", "Djibouti-Ambouli Airport", "Djibouti City", "Djibouti", "Africa/Djibouti", 11.5473, 43.1595],
  ["JIJ", "Gerad Wilwal International Airport", "Jijiga", "Ethiopia", "Africa/Addis_Ababa", 9.3319, 42.9118],
  ["JJN", "Quanzhou Jinjiang International Airport", "Quanzhou", "China", "Asia/Shanghai", 24.7959, 118.5886],
  ["JLG", "Jalgaon Airport", "Jalgaon", "India", "Asia/Kolkata", 20.9627, 75.6275],
  ["JLR", "Jabalpur Airport", "Jabalpur", "India", "Asia/Kolkata", 23.1778, 80.0520, "jabalpur airport jabalpur dzhabalpur"],
  ["JNB", "O.R. Tambo International Airport", "Johannesburg", "South Africa", "Africa/Johannesburg", -26.1401, 28.2468],
  ["JPA", "Presidente Castro Pinto International Airport", "João Pessoa", "Brazil", "America/Fortaleza", -7.1487, -34.9506, "presidente castro pinto international airport joão pessoa presidente castro pinto international airport joao pessoa"],
  ["JRG", "Jharsuguda Airport", "Jharsuguda", "India", "Asia/Kolkata", 21.9135, 84.0504],
  ["JRH", "Jorhat Airport", "Jorhat", "India", "Asia/Kolkata", 26.7305, 94.1754],
  ["JRO", "Kilimanjaro International Airport", "Arusha", "Tanzania", "Africa/Dar_es_Salaam", -3.4270, 37.0735],
  ["JSA", "Jaisalmer Airport", "Jaisalmer Airport", "India", "Asia/Kolkata", 26.8887, 70.8650],
  ["JTR", "Santorini International Airport", "Santorini Island", "Greece", "Europe/Athens", 36.4000, 25.4786],
  ["JUB", "Juba International Airport", "Juba", "South Sudan", "Africa/Juba", 4.8720, 31.6011],
  ["JUJ", "Gobernador Horacio Guzman International Airport", "San Salvador de Jujuy", "Argentina", "America/Argentina/Jujuy", -24.3928, -65.0978],
  ["JUL", "Inca Manco Capac International Airport", "Juliaca", "Peru", "America/Lima", -15.4677, -70.1565],
  ["KAD", "Kaduna International Airport", "Kaduna", "Nigeria", "Africa/Lagos", 10.6960, 7.3201],
  ["KAN", "Mallam Aminu Kano International Airport", "Kano", "Nigeria", "Africa/Lagos", 12.0456, 8.5236],
  ["KBL", "Kabul International Airport", "Kabul", "Afghanistan", "Asia/Kabul", 34.5659, 69.2123],
  ["KBV", "Krabi International Airport", "Krabi", "Thailand", "Asia/Bangkok", 8.0956, 98.9890],
  ["KCH", "Kuching International Airport", "Kuching", "Malaysia", "Asia/Kuching", 1.4874, 110.3529],
  ["KCZ", "Kochi Ryoma Airport", "Nankoku", "Japan", "Asia/Tokyo", 33.5452, 133.6702],
  ["KDH", "Ahmad Shah Baba International Airport", "Kandahar", "Afghanistan", "Asia/Kabul", 31.5058, 65.8480],
  ["KDU", "Skardu International Airport", "Skardu", "Pakistan", "Asia/Karachi", 35.3387, 75.5386],
  ["KEF", "Keflavik International Airport", "Reykjavík", "Iceland", "Atlantic/Reykjavik", 63.9850, -22.6056, "keflavik international airport reykjavík reykjavik keflavik international airport reykjavik reykjavik"],
  ["KEJ", "Alexei Leonov Kemerovo International Airport", "Kemerovo", "Russia", "Asia/Novokuznetsk", 55.2701, 86.1072],
  ["KER", "Ayatollah Hashemi Rafsanjani International Airport", "Kerman", "Iran", "Asia/Tehran", 30.2713, 56.9497],
  ["KGD", "Khrabrovo Airport", "Kaliningrad", "Russia", "Europe/Kaliningrad", 54.8916, 20.5986],
  ["KGF", "Sary-Arka Airport", "Karaganda", "Kazakhstan", "Asia/Almaty", 49.6708, 73.3344],
  ["KGL", "Kigali International Airport", "Kigali", "Rwanda", "Africa/Kigali", -1.9686, 30.1395],
  ["KGS", "Kos International Airport \"Ippokratis\"", "Kos Island", "Greece", "Europe/Athens", 36.7945, 27.0911],
  ["KHG", "Kashgar Laining International Airport", "Kashgar", "China", "Asia/Shanghai", 39.5423, 76.0202],
  ["KHH", "Kaohsiung International Airport", "Kaohsiung", "Taiwan", "Asia/Taipei", 22.5771, 120.3500, "kaohsiung international airport kaohsiung xiaogang"],
  ["KHI", "Jinnah International Airport", "Karachi", "Pakistan", "Asia/Karachi", 24.9065, 67.1608],
  ["KHN", "Nanchang Changbei International Airport", "Nanchang", "China", "Asia/Shanghai", 28.8648, 115.9027],
  ["KIH", "Kish International Airport", "Kish Island", "Iran", "Asia/Tehran", 26.5254, 53.9805],
  ["KIJ", "Niigata Airport", "Niigata", "Japan", "Asia/Tokyo", 37.9542, 139.1122],
  ["KIK", "Kirkuk International Airport", "Kirkuk", "Iraq", "Asia/Baghdad", 35.4695, 44.3489],
  ["KIM", "Kimberley Airport", "Kimberley", "South Africa", "Africa/Johannesburg", -28.8054, 24.7649],
  ["KIN", "Norman Manley International Airport", "Kingston", "Jamaica", "America/Jamaica", 17.9357, -76.7875],
  ["KIS", "Kisumu International Airport", "Kisumu", "Kenya", "Africa/Nairobi", -0.0861, 34.7289],
  ["KIX", "Kansai International Airport", "Osaka", "Japan", "Asia/Tokyo", 34.4273, 135.2440],
  ["KJA", "Krasnoyarsk International Airport", "Krasnoyarsk", "Russia", "Asia/Krasnoyarsk", 56.1757, 92.4858],
  ["KJB", "Kurnool Airport", "Kurnool", "India", "Asia/Kolkata", 15.7163, 78.1692, "kurnool airport kurnool orvakal"],
  ["KKJ", "Kitakyushu Airport", "Kitakyushu", "Japan", "Asia/Tokyo", 33.8459, 131.0350],
  ["KLH", "Kolhapur Airport", "Kolhapur", "India", "Asia/Kolkata", 16.6647, 74.2894],
  ["KLO", "Kalibo International Airport", "Kalibo", "Philippines", "Asia/Manila", 11.6794, 122.3760],
  ["KLU", "Klagenfurt Airport", "Klagenfurt am Wörthersee", "Austria", "Europe/Vienna", 46.6425, 14.3377, "klagenfurt airport klagenfurt am wörthersee klagenfurt airport klagenfurt am worthersee"],
  ["KLV", "Karlovy Vary Airport", "Karlovy Vary", "Czech Republic", "Europe/Prague", 50.2030, 12.9150],
  ["KMG", "Kunming Changshui International Airport", "Kunming", "China", "Asia/Shanghai", 25.1103, 102.9367],
  ["KMI", "Miyazaki Airport", "Miyazaki", "Japan", "Asia/Tokyo", 31.8772, 131.4490],
  ["KMJ", "Kumamoto Airport", "Kumamoto", "Japan", "Asia/Tokyo", 32.8373, 130.8550],
  ["KMQ", "Komatsu Airport / JASDF Komatsu Air Base", "Kanazawa", "Japan", "Asia/Tokyo", 36.3934, 136.4069],
  ["KMS", "Prempeh I International Airport", "Kumasi", "Ghana", "Africa/Accra", 6.7146, -1.5908],
  ["KNO", "Kualanamu International Airport", "Beringin", "Indonesia", "Asia/Jakarta", 3.6378, 98.8706],
  ["KNU", "Kanpur Airport", "Kanpur", "India", "Asia/Kolkata", 26.4043, 80.4101],
  ["KOA", "Ellison Onizuka Kona International Airport at Keāhole", "Kailua-Kona", "United States", "Pacific/Honolulu", 19.7388, -156.0456, "ellison onizuka kona international airport at keāhole kailua kona ellison onizuka kona international airport at keahole kailua kona"],
  ["KOJ", "Kagoshima Airport", "Kagoshima", "Japan", "Asia/Tokyo", 31.8034, 130.7190],
  ["KOS", "Sihanouk International Airport", "Preah Sihanouk", "Cambodia", "Asia/Phnom_Penh", 10.5706, 103.6321],
  ["KOV", "Kokshetau International Airport", "Kokshetau", "Kazakhstan", "Asia/Almaty", 53.3291, 69.5946],
  ["KQH", "Kishangarh Airport Ajmer", "Ajmer", "India", "Asia/Kolkata", 26.5910, 74.8130],
  ["KQT", "Bokhtar International Airport", "Bokhtar", "Tajikistan", "Asia/Dushanbe", 37.8663, 68.8645],
  ["KRK", "Kraków John Paul II International Airport", "Balice", "Poland", "Europe/Warsaw", 50.0777, 19.7848, "kraków john paul ii international airport balice krakow john paul ii international airport balice"],
  ["KRN", "Kiruna Airport", "Kiruna", "Sweden", "Europe/Stockholm", 67.8220, 20.3368],
  ["KRR", "Krasnodar Pashkovsky International Airport", "Krasnodar", "Russia", "Europe/Moscow", 45.0345, 39.1742],
  ["KRS", "Kristiansand Airport", "Kristiansand", "Norway", "Europe/Oslo", 58.2042, 8.0854, "kristiansand airport kristiansand kjevik"],
  ["KRT", "Khartoum International Airport", "Khartoum", "Sudan", "Africa/Khartoum", 15.5895, 32.5532],
  ["KSA", "Kosrae International Airport", "Okat", "Micronesia", "Pacific/Kosrae", 5.3570, 162.9580],
  ["KSF", "Kassel Airport", "Calden", "Germany", "Europe/Berlin", 51.4184, 9.3916],
  ["KSN", "Kostanay International Airport", "Kostanay", "Kazakhstan", "Asia/Qostanay", 53.2069, 63.5503],
  ["KTI", "Techo International Airport", "Phnom Penh", "Cambodia", "Asia/Phnom_Penh", 11.3600, 104.9213, "techo international airport phnom penh boeng khyang"],
  ["KTM", "Tribhuvan International Airport", "Kathmandu", "Nepal", "Asia/Kathmandu", 27.6966, 85.3591],
  ["KTT", "Kittilä International Airport", "Kittilä", "Finland", "Europe/Helsinki", 67.7010, 24.8468, "kittilä international airport kittilä kittila international airport kittila"],
  ["KTW", "Katowice Wojciech Korfanty International Airport", "Katowice", "Poland", "Europe/Warsaw", 50.4760, 19.0807],
  ["KUF", "Kurumoch International Airport", "Samara", "Russia", "Europe/Samara", 53.5049, 50.1643],
  ["KUL", "Kuala Lumpur International Airport", "Kuala Lumpur", "Malaysia", "Asia/Kuala_Lumpur", 2.7456, 101.7100, "kuala lumpur international airport kuala lumpur sepang"],
  ["KUN", "Kaunas International Airport", "Kaunas", "Lithuania", "Europe/Vilnius", 54.9640, 24.0858],
  ["KUO", "Kuopio Airport", "Kuopio / Siilinjärvi", "Finland", "Europe/Helsinki", 63.0071, 27.7978, "kuopio airport kuopio siilinjärvi kuopio airport kuopio siilinjarvi"],
  ["KUT", "David the Builder Kutaisi International Airport", "Kopitnari", "Georgia", "Asia/Tbilisi", 42.1774, 42.4854],
  ["KUU", "Kullu Manali Airport", "Kullu", "India", "Asia/Kolkata", 31.8767, 77.1544, "kullu manali airport kullu bhuntar"],
  ["KVA", "Kavala Alexander the Great International Airport", "Kavala", "Greece", "Europe/Athens", 40.9133, 24.6192],
  ["KWE", "Guiyang Longdongbao International Airport", "Guiyang", "China", "Asia/Shanghai", 26.5418, 106.8040, "guiyang longdongbao international airport guiyang nanming"],
  ["KWI", "Kuwait International Airport", "Kuwait City", "Kuwait", "Asia/Kuwait", 29.2245, 47.9698],
  ["KWL", "Guilin Liangjiang International Airport", "Guilin", "China", "Asia/Shanghai", 25.2198, 110.0396, "guilin liangjiang international airport guilin lingui"],
  ["KYA", "Konya Airport", "Konya", "Turkey", "Europe/Istanbul", 37.9790, 32.5619],
  ["KZN", "Kazan International Airport", "Kazan", "Russia", "Europe/Moscow", 55.6062, 49.2787],
  ["KZO", "Korkyt Ata International Airport", "Kyzylorda", "Kazakhstan", "Asia/Qyzylorda", 44.7069, 65.5925],
  ["LAD", "Quatro de Fevereiro International Airport", "Luanda", "Angola", "Africa/Luanda", -8.8584, 13.2312],
  ["LAE", "Nadzab Tomodachi International Airport", "Lae", "Papua New Guinea", "Pacific/Port_Moresby", -6.5680, 146.7265],
  ["LAO", "Laoag International Airport", "Laoag City", "Philippines", "Asia/Manila", 18.1751, 120.5310],
  ["LAQ", "Al Abraq International Airport", "Al Albraq", "Libya", "Africa/Tripoli", 32.7890, 21.9549],
  ["LAS", "Harry Reid International Airport", "Las Vegas", "United States", "America/Los_Angeles", 36.0834, -115.1518],
  ["LAX", "Los Angeles International Airport", "Los Angeles", "United States", "America/Los_Angeles", 33.9425, -118.4080],
  ["LBA", "Leeds Bradford Airport", "Leeds", "United Kingdom", "Europe/London", 53.8659, -1.6606, "leeds bradford airport leeds west yorkshire"],
  ["LBD", "Khujand International Airport", "Khujand", "Tajikistan", "Asia/Dushanbe", 40.2154, 69.6947],
  ["LBG", "Paris-Le Bourget International Airport", "Paris", "France", "Europe/Paris", 48.9623, 2.4365],
  ["LBV", "Libreville Leon M'ba International Airport", "Libreville", "Gabon", "Africa/Libreville", 0.4590, 9.4121],
  ["LCA", "Larnaca International Airport", "Larnaca", "Cyprus", "Asia/Nicosia", 34.8751, 33.6249],
  ["LCJ", "Łódź Władysław Reymont Airport", "Łódź", "Poland", "Europe/Warsaw", 51.7219, 19.3981, "łódź władysław reymont airport łódź łodz władysław reymont airport łodz"],
  ["LED", "Pulkovo Airport", "St. Petersburg", "Russia", "Europe/Moscow", 59.8003, 30.2625],
  ["LEJ", "Leipzig/Halle Airport", "Leipzig", "Germany", "Europe/Berlin", 51.4207, 12.2327, "leipzig halle airport leipzig schkeuditz"],
  ["LFW", "Lomé–Tokoin International Airport", "Lomé", "Togo", "Africa/Lome", 6.1656, 1.2545, "lomé tokoin international airport lomé lome tokoin international airport lome"],
  ["LGA", "LaGuardia Airport", "New York", "United States", "America/New_York", 40.7772, -73.8726],
  ["LGB", "Long Beach International Airport", "Long Beach", "United States", "America/Los_Angeles", 33.8165, -118.1499],
  ["LGK", "Langkawi International Airport", "Langkawi", "Malaysia", "Asia/Kuala_Lumpur", 6.3297, 99.7287],
  ["LGW", "London Gatwick Airport", "London", "United Kingdom", "Europe/London", 51.1487, -0.1857],
  ["LHE", "Allama Iqbal International Airport", "Lahore", "Pakistan", "Asia/Karachi", 31.5216, 74.4036],
  ["LHR", "London Heathrow Airport", "London", "United Kingdom", "Europe/London", 51.4707, -0.4599],
  ["LHW", "Lanzhou Zhongchuan International Airport", "Lanzhou", "China", "Asia/Shanghai", 36.5152, 103.6200, "lanzhou zhongchuan international airport lanzhou yongdeng"],
  ["LIH", "Lihue Airport", "Lihue", "United States", "Pacific/Honolulu", 21.9744, -159.3371, "lihue airport lihue kauai"],
  ["LIL", "Lille Airport", "Lesquin", "France", "Europe/Paris", 50.5666, 3.1024],
  ["LIM", "Jorge Chávez International Airport", "Lima", "Peru", "America/Lima", -12.0219, -77.1143, "jorge chávez international airport lima jorge chavez international airport lima"],
  ["LIN", "Milano Linate Airport", "Milan", "Italy", "Europe/Rome", 45.4451, 9.2767, "milano linate airport milan mi segrate"],
  ["LIR", "Daniel Oduber Quirós International Airport", "Liberia", "Costa Rica", "America/Costa_Rica", 10.5933, -85.5444, "daniel oduber quirós international airport liberia daniel oduber quiros international airport liberia"],
  ["LIS", "Lisbon Humberto Delgado Airport", "Lisbon", "Portugal", "Europe/Lisbon", 38.7813, -9.1359],
  ["LJG", "Lijiang Sanyi International Airport", "Lijiang", "China", "Asia/Shanghai", 26.6775, 100.2449],
  ["LJU", "Ljubljana Jože Pučnik Airport", "Zgornji Brnik", "Slovenia", "Europe/Ljubljana", 46.2237, 14.4576, "ljubljana jože pučnik airport zgornji brnik ljubljana joze pucnik airport zgornji brnik"],
  ["LKO", "Chaudhary Charan Singh International Airport", "Lucknow", "India", "Asia/Kolkata", 26.7606, 80.8893],
  ["LLA", "Luleå Airport", "Luleå", "Sweden", "Europe/Stockholm", 65.5438, 22.1220, "luleå airport luleå lulea airport lulea"],
  ["LLW", "Kamuzu International Airport", "Lumbadzi", "Malawi", "Africa/Blantyre", -13.7894, 33.7810],
  ["LNZ", "Linz-Hörsching Airport", "Linz", "Austria", "Europe/Vienna", 48.2354, 14.1881, "linz hörsching airport linz linz horsching airport linz"],
  ["LOP", "Lombok International Airport", "Mataram", "Indonesia", "Asia/Makassar", -8.7600, 116.2782, "lombok international airport mataram pujut tengah"],
  ["LOS", "Murtala Muhammed International Airport", "Lagos", "Nigeria", "Africa/Lagos", 6.5774, 3.3212],
  ["LPA", "Gran Canaria Airport", "Gran Canaria Island", "Spain", "Atlantic/Canary", 27.9319, -15.3866],
  ["LPB", "El Alto International Airport", "La Paz / El Alto", "Bolivia", "America/La_Paz", -16.5103, -68.1894],
  ["LPI", "Linköping City Airport", "Linköping", "Sweden", "Europe/Stockholm", 58.4049, 15.6845, "linköping city airport linköping linkoping city airport linkoping"],
  ["LPL", "Liverpool John Lennon Airport", "Liverpool", "United Kingdom", "Europe/London", 53.3349, -2.8496],
  ["LPP", "Lappeenranta Airport", "Lappeenranta", "Finland", "Europe/Helsinki", 61.0446, 28.1447],
  ["LPQ", "Luang Phabang International Airport", "Luang Phabang", "Laos", "Asia/Vientiane", 19.9043, 102.1672],
  ["LRM", "Casa De Campo International Airport", "La Romana", "Dominican Republic", "America/Santo_Domingo", 18.4522, -68.9111],
  ["LTN", "London Luton Airport", "Luton", "United Kingdom", "Europe/London", 51.8747, -0.3683],
  ["LTO", "Loreto International Airport", "Loreto", "Mexico", "America/Mazatlan", 25.9895, -111.3484],
  ["LTU", "Murod Kond Airport", "Latur", "India", "Asia/Kolkata", 18.4115, 76.4647],
  ["LUN", "Kenneth Kaunda International Airport", "Lusaka", "Zambia", "Africa/Lusaka", -15.3308, 28.4527],
  ["LUX", "Luxembourg-Findel International Airport", "Luxembourg", "Luxembourg", "Europe/Luxembourg", 49.6268, 6.2121],
  ["LUZ", "Lublin Airport", "Lublin", "Poland", "Europe/Warsaw", 51.2402, 22.7135],
  ["LVI", "Harry Mwanga Nkumbula International Airport", "Livingstone", "Zambia", "Africa/Lusaka", -17.8215, 25.8196],
  ["LWN", "Shirak International Airport", "Gyumri", "Armenia", "Asia/Yerevan", 40.7504, 43.8593],
  ["LXA", "Lhasa Gonggar International Airport", "Shannan", "China", "Asia/Shanghai", 29.2980, 90.9120],
  ["LXR", "Luxor International Airport", "Luxor", "Egypt", "Africa/Cairo", 25.6710, 32.7064],
  ["LYA", "Luoyang Beijiao Airport", "Luoyang", "China", "Asia/Shanghai", 34.7411, 112.3880, "luoyang beijiao airport luoyang laocheng"],
  ["LYG", "Lianyungang Huaguoshan International Airport", "Lianyungang", "China", "Asia/Shanghai", 34.4141, 119.1790],
  ["LYP", "Faisalabad International Airport", "Faisalabad", "Pakistan", "Asia/Karachi", 31.3649, 72.9953],
  ["LYS", "Lyon Saint-Exupéry Airport", "Lyon", "France", "Europe/Paris", 45.7260, 5.0901, "lyon saint exupéry airport lyon rhône colombier saugnieu lyon saint exupery airport lyon rhone colombier saugnieu"],
  ["MAA", "Chennai International Airport", "Chennai", "India", "Asia/Kolkata", 12.9900, 80.1693, "chennai international airport chennai madras"],
  ["MAD", "Adolfo Suárez Madrid–Barajas Airport", "Madrid", "Spain", "Europe/Madrid", 40.4934, -3.5722, "adolfo suárez madrid barajas airport madrid adolfo suarez madrid barajas airport madrid"],
  ["MAH", "Menorca Airport", "Mahón", "Spain", "Europe/Madrid", 39.8626, 4.2187, "menorca airport mahón maó menorca airport mahon mao"],
  ["MAJ", "Marshall Islands International Airport", "Majuro Atoll", "Marshall Islands", "Pacific/Majuro", 7.0651, 171.2717],
  ["MAN", "Manchester Airport", "Manchester", "United Kingdom", "Europe/London", 53.3494, -2.2795, "manchester airport manchester greater"],
  ["MAO", "Eduardo Gomes International Airport", "Manaus", "Brazil", "America/Manaus", -3.0386, -60.0497],
  ["MAR", "La Chinita International Airport", "Maracaibo", "Venezuela", "America/Caracas", 10.5575, -71.7293],
  ["MBA", "Moi International Airport", "Mombasa", "Kenya", "Africa/Nairobi", -4.0348, 39.5942],
  ["MBJ", "Sangster International Airport", "Montego Bay", "Jamaica", "America/Jamaica", 18.5034, -77.9132],
  ["MCI", "Kansas City International Airport", "Kansas City", "United States", "America/Chicago", 39.3017, -94.7139],
  ["MCO", "Orlando International Airport", "Orlando", "United States", "America/New_York", 28.4294, -81.3090],
  ["MCT", "Muscat International Airport", "Muscat/Seeb", "Oman", "Asia/Muscat", 23.6002, 58.2853],
  ["MCX", "Makhachkala Uytash International Airport", "Makhachkala", "Russia", "Europe/Moscow", 42.8168, 47.6523],
  ["MCY", "Sunshine Coast Airport", "Maroochydore", "Australia", "Australia/Brisbane", -26.5933, 153.0832],
  ["MCZ", "Zumbi dos Palmares International Airport", "Maceió", "Brazil", "America/Maceio", -9.5126, -35.7918, "zumbi dos palmares international airport maceió zumbi dos palmares international airport maceio"],
  ["MDC", "Sam Ratulangi International Airport", "Manado", "Indonesia", "Asia/Makassar", 1.5486, 124.9262],
  ["MDE", "Jose Maria Córdova International Airport", "Medellín", "Colombia", "America/Bogota", 6.1645, -75.4231, "jose maria córdova international airport medellín jose maria cordova international airport medellin"],
  ["MDL", "Mandalay International Airport", "Mandalay", "Myanmar", "Asia/Yangon", 21.7022, 95.9779],
  ["MDW", "Chicago Midway International Airport", "Chicago", "United States", "America/Chicago", 41.7860, -87.7524],
  ["MDZ", "Governor Francisco Gabrielli International Airport", "Mendoza", "Argentina", "America/Argentina/Mendoza", -32.8317, -68.7929],
  ["MED", "Prince Mohammad Bin Abdulaziz Airport", "Medina", "Saudi Arabia", "Asia/Riyadh", 24.5534, 39.7051],
  ["MEL", "Melbourne Airport", "Melbourne", "Australia", "Australia/Melbourne", -37.6707, 144.8379],
  ["MEM", "Frederick W. Smith International Airport", "Memphis", "United States", "America/Chicago", 35.0438, -89.9763],
  ["MEX", "Mexico City Benito Juárez International Airport", "Mexico City", "Mexico", "America/Mexico_City", 19.4358, -99.0703, "mexico city benito juárez international airport mexico city mexico city benito juarez international airport mexico city"],
  ["MFM", "Macau International Airport", "Nossa Senhora do Carmo", "Macau", "Asia/Macau", 22.1496, 113.5920],
  ["MFU", "Mfuwe International Airport", "Mfuwe", "Zambia", "Africa/Lusaka", -13.2589, 31.9366],
  ["MGA", "Augusto C. Sandino (Managua) International Airport", "Managua", "Nicaragua", "America/Managua", 12.1415, -86.1682],
  ["MGQ", "Aden Adde International Airport", "Mogadishu", "Somalia", "Africa/Mogadishu", 2.0144, 45.3047],
  ["MHD", "Mashhad International Airport", "Mashhad", "Iran", "Asia/Tehran", 36.2348, 59.6429],
  ["MIA", "Miami International Airport", "Miami", "United States", "America/New_York", 25.7960, -80.2898],
  ["MID", "Manuel Crescencio Rejón International Airport", "Mérida", "Mexico", "America/Merida", 20.9305, -89.6455, "manuel crescencio rejón international airport mérida manuel crescencio rejon international airport merida"],
  ["MIU", "Maiduguri International Airport", "Maiduguri", "Nigeria", "Africa/Lagos", 11.8542, 13.0807],
  ["MJI", "Mitiga International Airport", "Tripoli", "Libya", "Africa/Tripoli", 32.8918, 13.2879],
  ["MJN", "Amborovy Airport", "Mahajanga", "Madagascar", "Indian/Antananarivo", -15.6668, 46.3512],
  ["MKE", "General Mitchell International Airport", "Milwaukee", "United States", "America/Chicago", 42.9472, -87.8966],
  ["MLA", "Malta International Airport", "Valletta", "Malta", "Europe/Malta", 35.8459, 14.4915],
  ["MLE", "Velana International Airport", "Malé", "Maldives", "Indian/Maldives", 4.1918, 73.5291, "velana international airport malé velana international airport male"],
  ["MLM", "General Francisco J. Mujica International Airport", "Morelia", "Mexico", "America/Mexico_City", 19.8499, -101.0250],
  ["MMK", "Emperor Nicholas II Murmansk Airport", "Murmansk", "Russia", "Europe/Moscow", 68.7817, 32.7508],
  ["MMX", "Malmö Sturup Airport", "Malmö", "Sweden", "Europe/Stockholm", 55.5356, 13.3763, "malmö sturup airport malmö malmo sturup airport malmo"],
  ["MNI", "John A. Osborne Airport", "Gerald's Park", "Montserrat", "America/Montserrat", 16.7918, -62.1932],
  ["MNL", "Ninoy Aquino International Airport", "Manila", "Philippines", "Asia/Manila", 14.5086, 121.0200, "ninoy aquino international airport manila pasay"],
  ["MPL", "Montpellier-Méditerranée Airport", "Montpellier/Méditerranée", "France", "Europe/Paris", 43.5762, 3.9630, "montpellier méditerranée airport montpellier méditerranée montpellier mediterranee airport montpellier mediterranee"],
  ["MPM", "Maputo Airport", "Maputo", "Mozambique", "Africa/Maputo", -25.9208, 32.5726],
  ["MPN", "Mount Pleasant Airport / RAF Mount Pleasant", "Mount Pleasant", "Falkland Islands", "Atlantic/Stanley", -51.8226, -58.4458],
  ["MQF", "Magnitogorsk International Airport", "Magnitogorsk", "Russia", "Asia/Yekaterinburg", 53.3920, 58.7552],
  ["MQP", "Kruger Mpumalanga International Airport", "Mbombela", "South Africa", "Africa/Johannesburg", -25.3833, 31.1053],
  ["MRS", "Marseille Provence Airport", "Marseille", "France", "Europe/Paris", 43.4381, 5.2125, "marseille provence airport marseille bouches du rhône marignane marseille provence airport marseille bouches du rhone marignane"],
  ["MRU", "Sir Seewoosagur Ramgoolam International Airport", "Plaine Magnien", "Mauritius", "Indian/Mauritius", -20.4302, 57.6836],
  ["MRV", "Mineralnye Vody Airport", "Mineralnyye Vody", "Russia", "Europe/Moscow", 44.2251, 43.0819],
  ["MSP", "Minneapolis–Saint Paul International Airport / Wold–Chamberlain Field", "Minneapolis", "United States", "America/Chicago", 44.8801, -93.2217],
  ["MSQ", "Minsk National Airport", "Minsk", "Belarus", "Europe/Minsk", 53.8881, 28.0400],
  ["MST", "Maastricht Aachen Airport", "Maastricht", "Netherlands", "Europe/Amsterdam", 50.9111, 5.7694],
  ["MSU", "Moshoeshoe I International Airport", "Maseru", "Lesotho", "Africa/Maseru", -29.4563, 27.5545, "moshoeshoe i international airport maseru mazenod"],
  ["MSY", "Louis Armstrong New Orleans International Airport", "New Orleans", "United States", "America/Chicago", 29.9934, -90.2647],
  ["MTY", "Monterrey International Airport", "Monterrey", "Mexico", "America/Monterrey", 25.7785, -100.1070],
  ["MUB", "Maun International Airport", "Maun", "Botswana", "Africa/Gaborone", -19.9705, 23.4314],
  ["MUC", "Munich Airport", "Munich", "Germany", "Europe/Berlin", 48.3538, 11.7861],
  ["MUH", "Mersa Matruh International Airport", "Marsa Matruh", "Egypt", "Africa/Cairo", 31.3243, 27.2223],
  ["MUX", "Multan International Airport", "Multan", "Pakistan", "Asia/Karachi", 30.2032, 71.4191],
  ["MVD", "Carrasco General Cesáreo L. Berisso International Airport", "Ciudad de la Costa", "Uruguay", "America/Montevideo", -34.8356, -56.0265, "carrasco general cesáreo l berisso international airport ciudad de la costa carrasco general cesareo l berisso international airport ciudad de la costa"],
  ["MWX", "Muan International Airport", "Muan", "South Korea", "Asia/Seoul", 34.9914, 126.3828, "muan international airport muan piseo ri"],
  ["MWZ", "Mwanza International Airport", "Mwanza", "Tanzania", "Africa/Dar_es_Salaam", -2.4466, 32.9360],
  ["MXP", "Milan Malpensa International Airport", "Milan", "Italy", "Europe/Rome", 45.6306, 8.7281, "milan malpensa international airport milan va ferno"],
  ["MYJ", "Matsuyama Airport", "Matsuyama", "Japan", "Asia/Tokyo", 33.8269, 132.7001],
  ["MYQ", "Mysore Airport", "Mysore", "India", "Asia/Kolkata", 12.2298, 76.6537, "mysore airport mysore mysuru"],
  ["MYR", "Myrtle Beach International Airport", "Myrtle Beach", "United States", "America/New_York", 33.6797, -78.9283],
  ["MZG", "Penghu Magong Airport", "Huxi", "Taiwan", "Asia/Taipei", 23.5687, 119.6280],
  ["MZR", "Mazar-i-Sharif International Airport", "Mazar-i-Sharif", "Afghanistan", "Asia/Kabul", 36.7041, 67.2105],
  ["MZS", "Moradabad Airport", "Moradabad", "India", "Asia/Kolkata", 28.8175, 78.9219],
  ["MZT", "General Rafael Buelna International Airport", "Mazatlàn", "Mexico", "America/Mazatlan", 23.1628, -106.2645, "general rafael buelna international airport mazatlàn general rafael buelna international airport mazatlan"],
  ["NAG", "Dr. Babasaheb Ambedkar International Airport", "Nagpur", "India", "Asia/Kolkata", 21.0922, 79.0472, "dr babasaheb ambedkar international airport nagpur naqpur"],
  ["NAJ", "Nakhchivan International Airport", "Nakhchivan", "Azerbaijan", "Asia/Baku", 39.1888, 45.4584],
  ["NAN", "Nadi International Airport", "Nadi", "Fiji", "Pacific/Fiji", -17.7618, 177.4378],
  ["NAP", "Naples International Airport", "Napoli", "Italy", "Europe/Rome", 40.8860, 14.2908],
  ["NAS", "Lynden Pindling International Airport", "Nassau", "Bahamas", "America/Nassau", 25.0390, -77.4662],
  ["NAT", "Rio Grande do Norte/São Gonçalo do Amarante–Governador Aluízio Alves International Airport", "Natal", "Brazil", "America/Fortaleza", -5.7698, -35.3666, "rio grande do norte são gonçalo do amarante governador aluízio alves international airport natal rio grande do norte sao goncalo do amarante governador aluizio alves international airport natal"],
  ["NAV", "Nevşehir Kapadokya Airport", "Nevşehir", "Turkey", "Europe/Istanbul", 38.7719, 34.5345, "nevşehir kapadokya airport nevşehir nevsehir kapadokya airport nevsehir"],
  ["NBJ", "Dr. Antonio Agostinho Neto International Airport", "Luanda", "Angola", "Africa/Luanda", -9.0507, 13.4991, "dr antonio agostinho neto international airport luanda ícolo e bengo dr antonio agostinho neto international airport luanda icolo e bengo"],
  ["NBO", "Jomo Kenyatta International Airport", "Nairobi", "Kenya", "Africa/Nairobi", -1.3189, 36.9282],
  ["NCE", "Nice-Côte d'Azur Airport", "Nice", "France", "Europe/Paris", 43.6584, 7.2159, "nice côte d azur airport nice alpes maritimes nice cote d azur airport nice alpes maritimes"],
  ["NCL", "Newcastle International Airport", "Newcastle upon Tyne", "United Kingdom", "Europe/London", 55.0380, -1.6896, "newcastle international airport newcastle upon tyne and wear"],
  ["NCU", "Nukus International Airport", "Nukus", "Uzbekistan", "Asia/Samarkand", 42.4884, 59.6233],
  ["NDB", "Nouadhibou International Airport", "Nouadhibou", "Mauritania", "Africa/El_Aaiun", 20.9324, -17.0302],
  ["NDC", "Nanded Airport", "Nanded", "India", "Asia/Kolkata", 19.1833, 77.3167],
  ["NDG", "Qiqihar Sanjiazi Airport", "Qiqihar", "China", "Asia/Shanghai", 47.2300, 123.9142],
  ["NDJ", "N'Djamena International Airport", "N'Djamena", "Chad", "Africa/Ndjamena", 12.1337, 15.0340],
  ["NDR", "Nador Al Aaroui International Airport", "Al Aaroui", "Morocco", "Africa/Casablanca", 34.9888, -3.0282],
  ["NGB", "Ningbo Lishe International Airport", "Ningbo", "China", "Asia/Shanghai", 29.8267, 121.4620],
  ["NGO", "Chubu Centrair International Airport", "Tokoname", "Japan", "Asia/Tokyo", 34.8584, 136.8050],
  ["NGS", "Nagasaki Airport", "Nagasaki", "Japan", "Asia/Tokyo", 32.9169, 129.9140],
  ["NIM", "Diori Hamani International Airport", "Niamey", "Niger", "Africa/Niamey", 13.4815, 2.1836],
  ["NJC", "Nizhnevartovsk Airport", "Nizhnevartovsk", "Russia", "Asia/Yekaterinburg", 60.9493, 76.4836],
  ["NJF", "Al Najaf International Airport", "Najaf", "Iraq", "Asia/Baghdad", 31.9911, 44.4050],
  ["NKC", "Nouakchott–Oumtounsy International Airport", "Nouakchott", "Mauritania", "Africa/Nouakchott", 18.3100, -15.9697],
  ["NKG", "Nanjing Lukou International Airport", "Nanjing", "China", "Asia/Shanghai", 31.7350, 118.8659],
  ["NLA", "Simon Mwansa Kapwepwe International Airport", "Ndola", "Zambia", "Africa/Lusaka", -12.9651, 28.5156],
  ["NLU", "Felipe Ángeles International Airport", "Mexico City", "Mexico", "America/Mexico_City", 19.7438, -99.0151, "felipe ángeles international airport mexico city felipe angeles international airport mexico city"],
  ["NMA", "Namangan International Airport", "Namangan", "Uzbekistan", "Asia/Tashkent", 40.9846, 71.5578],
  ["NMI", "Navi Mumbai International Airport", "Navi Mumbai", "India", "Asia/Kolkata", 18.9846, 73.0653],
  ["NNG", "Nanning Wuxu International Airport", "Nanning", "China", "Asia/Shanghai", 22.5981, 108.1819, "nanning wuxu international airport nanning jiangnan"],
  ["NOC", "Ireland West Airport Knock", "Charlestown", "Ireland", "Europe/Dublin", 53.9104, -8.8170],
  ["NOS", "Nosy Be International Airport", "Nosy Be", "Madagascar", "Indian/Antananarivo", -13.3121, 48.3148],
  ["NOU", "La Tontouta International Airport", "Nouméa", "New Caledonia", "Pacific/Noumea", -22.0146, 166.2130, "la tontouta international airport nouméa la tontouta international airport noumea"],
  ["NQN", "Presidente Perón International Airport", "Neuquén", "Argentina", "America/Argentina/Salta", -38.9490, -68.1557, "presidente perón international airport neuquén presidente peron international airport neuquen"],
  ["NQZ", "Nursultan Nazarbayev International Airport", "Astana", "Kazakhstan", "Asia/Almaty", 51.0270, 71.4671],
  ["NRN", "Weeze (Niederrhein) Airport", "Weeze", "Germany", "Europe/Amsterdam", 51.6014, 6.1412],
  ["NRT", "Narita International Airport", "Tokyo", "Japan", "Asia/Tokyo", 35.7686, 140.3887],
  ["NSI", "Yaoundé Nsimalen International Airport", "Yaoundé", "Cameroon", "Africa/Douala", 3.7226, 11.5533, "yaoundé nsimalen international airport yaoundé yaounde nsimalen international airport yaounde"],
  ["NSK", "Alykel International Airport", "Norilsk", "Russia", "Asia/Krasnoyarsk", 69.3080, 87.3259],
  ["NTE", "Nantes Atlantique Airport", "Nantes", "France", "Europe/Paris", 47.1532, -1.6107],
  ["NTL", "Newcastle Airport", "Williamtown", "Australia", "Australia/Sydney", -32.7961, 151.8350],
  ["NUE", "Nuremberg Airport", "Nuremberg", "Germany", "Europe/Berlin", 49.4987, 11.0781],
  ["NUM", "Neom Bay Airport", "Sharma", "Saudi Arabia", "Asia/Riyadh", 27.9243, 35.2936],
  ["NVT", "Ministro Victor Konder International Airport", "Navegantes", "Brazil", "America/Sao_Paulo", -26.8794, -48.6510],
  ["NYO", "Stockholm Skavsta Airport", "Nyköping", "Sweden", "Europe/Stockholm", 58.7897, 16.9115, "stockholm skavsta airport nyköping stockholm skavsta airport nykoping"],
  ["NYT", "Nay Pyi Taw International Airport", "Naypyitaw", "Myanmar", "Asia/Yangon", 19.6235, 96.2010],
  ["OAK", "Oakland San Francisco Bay Airport", "Oakland", "United States", "America/Los_Angeles", 37.7201, -122.2212],
  ["OAX", "Xoxocotlán International Airport", "Oaxaca", "Mexico", "America/Mexico_City", 16.9988, -96.7261, "xoxocotlán international airport oaxaca xoxocotlan international airport oaxaca"],
  ["OCS", "Corisco International Airport", "Corisco Island", "Equatorial Guinea", "Africa/Malabo", 0.9109, 9.3303],
  ["ODE", "Odense Hans Christian Andersen Airport", "Odense", "Denmark", "Europe/Copenhagen", 55.4753, 10.3272],
  ["OEC", "Oecusse Route of the Sandalwood International Airport", "Oecussi-Ambeno", "Timor-Leste", "Asia/Dili", -9.1984, 124.3379],
  ["OGG", "Kahului International Airport", "Kahului", "United States", "Pacific/Honolulu", 20.8963, -156.4318],
  ["OHD", "Ohrid St. Paul the Apostle Airport", "Ohrid", "North Macedonia", "Europe/Skopje", 41.1800, 20.7423],
  ["OHS", "Suhar International Airport", "Suhar", "Oman", "Asia/Muscat", 24.3860, 56.6254],
  ["OKA", "Naha International Airport", "Naha", "Japan", "Asia/Tokyo", 26.1924, 127.6398],
  ["OKC", "OKC Will Rogers World Airport", "Oklahoma City", "United States", "America/Chicago", 35.3934, -97.5982],
  ["OKJ", "Okayama Momotaro Airport", "Okayama", "Japan", "Asia/Tokyo", 34.7569, 133.8550],
  ["OLB", "Olbia Costa Smeralda Airport", "Olbia", "Italy", "Europe/Rome", 40.8990, 9.5185, "olbia costa smeralda airport olbia ss"],
  ["OMA", "Eppley Airfield", "Omaha", "United States", "America/Chicago", 41.3032, -95.8941],
  ["OMO", "Mostar International Airport", "Mostar", "Bosnia and Herzegovina", "Europe/Sarajevo", 43.2825, 17.8461],
  ["OMR", "Oradea International Airport", "Oradea", "Romania", "Europe/Bucharest", 47.0253, 21.9025],
  ["OMS", "Omsk Central Airport", "Omsk", "Russia", "Asia/Omsk", 54.9631, 73.3124],
  ["ONT", "Ontario International Airport", "Ontario", "United States", "America/Los_Angeles", 34.0560, -117.6010],
  ["OOL", "Gold Coast Airport", "Gold Coast", "Australia", "Australia/Brisbane", -28.1660, 153.5066],
  ["OPO", "Francisco de Sá Carneiro Airport", "Porto", "Portugal", "Europe/Lisbon", 41.2481, -8.6814, "francisco de sá carneiro airport porto francisco de sa carneiro airport porto"],
  ["ORD", "Chicago O'Hare International Airport", "Chicago", "United States", "America/Chicago", 41.9786, -87.9048],
  ["ORF", "Norfolk International Airport", "Norfolk", "United States", "America/New_York", 36.8953, -76.2010],
  ["ORK", "Cork International Airport", "Cork", "Ireland", "Europe/Dublin", 51.8413, -8.4911],
  ["ORN", "Oran Es-Sénia (Ahmed Ben Bella) International Airport", "Es-Sénia", "Algeria", "Africa/Algiers", 35.6206, -0.6225, "oran es sénia ahmed ben bella international airport es sénia oran es senia ahmed ben bella international airport es senia"],
  ["ORU", "Juan Mendoza International Airport", "Oruro", "Bolivia", "America/La_Paz", -17.9562, -67.0758],
  ["ORY", "Paris-Orly Airport", "Paris", "France", "Europe/Paris", 48.7295, 2.3590, "paris orly airport paris val de marne"],
  ["OSL", "Oslo-Gardermoen International Airport", "Oslo", "Norway", "Europe/Oslo", 60.1939, 11.1004],
  ["OSR", "Leoš Janáček Airport Ostrava", "Mošnov", "Czech Republic", "Europe/Prague", 49.6963, 18.1111, "leoš janáček airport ostrava mošnov leos janacek airport ostrava mosnov"],
  ["OSS", "Osh International Airport", "Osh", "Kyrgyzstan", "Asia/Bishkek", 40.6090, 72.7933],
  ["OST", "Ostend-Bruges International Airport", "Oostende", "Belgium", "Europe/Brussels", 51.1998, 2.8747],
  ["OTP", "Bucharest Henri Coandă International Airport", "Bucharest", "Romania", "Europe/Bucharest", 44.5718, 26.1033, "bucharest henri coandă international airport bucharest otopeni bucharest henri coanda international airport bucharest otopeni"],
  ["OUA", "Ouagadougou Thomas Sankara International Airport", "Ouagadougou", "Burkina Faso", "Africa/Ouagadougou", 12.3532, -1.5124],
  ["OUD", "Oujda Angads Airport", "Ahl Angad", "Morocco", "Africa/Casablanca", 34.7896, -1.9260],
  ["OUL", "Oulu Airport", "Oulu / Oulunsalo", "Finland", "Europe/Helsinki", 64.9301, 25.3546],
  ["OVB", "Novosibirsk Tolmachevo Airport", "Novosibirsk", "Russia", "Asia/Novosibirsk", 55.0198, 82.6187],
  ["OVD", "Asturias Airport", "Ranón", "Spain", "Europe/Madrid", 43.5636, -6.0346, "asturias airport ranón asturias airport ranon"],
  ["OXB", "Osvaldo Vieira International Airport", "Bissau", "Guinea-Bissau", "Africa/Bissau", 11.8943, -15.6536],
  ["OZG", "Zagora Airport", "Zagora", "Morocco", "Africa/Casablanca", 30.2658, -5.8608],
  ["OZZ", "Ouarzazate International Airport", "Ouarzazate", "Morocco", "Africa/Casablanca", 30.9391, -6.9094],
  ["PAB", "Bilaspur Airport", "Bilaspur", "India", "Asia/Kolkata", 21.9884, 82.1110],
  ["PAD", "Paderborn Lippstadt Airport", "Paderborn", "Germany", "Europe/Berlin", 51.6125, 8.6175, "paderborn lippstadt airport paderborn büren paderborn lippstadt airport paderborn buren"],
  ["PAP", "Toussaint Louverture International Airport", "Port-au-Prince", "Haiti", "America/Port-au-Prince", 18.5800, -72.2926],
  ["PAT", "Jay Prakash Narayan Airport", "Patna", "India", "Asia/Kolkata", 25.5913, 85.0880],
  ["PBC", "Hermanos Serdán International Airport", "Puebla", "Mexico", "America/Mexico_City", 19.1585, -98.3716, "hermanos serdán international airport puebla hermanos serdan international airport puebla"],
  ["PBD", "Porbandar Airport", "Porbandar", "India", "Asia/Kolkata", 21.6495, 69.6564],
  ["PBH", "Paro International Airport", "Paro", "Bhutan", "Asia/Thimphu", 27.4032, 89.4246],
  ["PBM", "Johan Adolf Pengel International Airport", "Paramaribo", "Suriname", "America/Paramaribo", 5.4528, -55.1878],
  ["PCL", "Cap FAP David Abenzur Rengifo International Airport", "Pucallpa", "Peru", "America/Lima", -8.3781, -74.5745],
  ["PDG", "Minangkabau International Airport", "Padang", "Indonesia", "Asia/Jakarta", -0.7860, 100.2804, "minangkabau international airport padang katapiang"],
  ["PDL", "João Paulo II Airport", "Ponta Delgada", "Portugal", "Atlantic/Azores", 37.7412, -25.6979, "joão paulo ii airport ponta delgada joao paulo ii airport ponta delgada"],
  ["PDV", "Plovdiv International Airport", "Plovdiv", "Bulgaria", "Europe/Sofia", 42.0678, 24.8508],
  ["PDX", "Portland International Airport", "Portland", "United States", "America/Los_Angeles", 45.5887, -122.5980],
  ["PED", "Pardubice Airport", "Pardubice", "Czech Republic", "Europe/Prague", 50.0150, 15.7398],
  ["PEE", "Perm International Airport", "Perm", "Russia", "Asia/Yekaterinburg", 57.9145, 56.0212],
  ["PEG", "Perugia San Francesco d'Assisi – Umbria International Airport", "Perugia", "Italy", "Europe/Rome", 43.0959, 12.5132, "perugia san francesco d assisi umbria international airport perugia pg"],
  ["PEK", "Beijing Capital International Airport", "Beijing", "China", "Asia/Shanghai", 40.0773, 116.5967],
  ["PEN", "Penang International Airport", "Penang", "Malaysia", "Asia/Kuala_Lumpur", 5.2963, 100.2762],
  ["PER", "Perth International Airport", "Perth", "Australia", "Australia/Perth", -31.9403, 115.9670],
  ["PEV", "Pécs-Pogány International Airport", "Pécs", "Hungary", "Europe/Budapest", 45.9889, 18.2420, "pécs pogány international airport pécs pecs pogany international airport pecs"],
  ["PEW", "Bacha Khan International Airport", "Peshawar", "Pakistan", "Asia/Karachi", 33.9939, 71.5146],
  ["PFO", "Paphos International Airport", "Paphos", "Cyprus", "Asia/Nicosia", 34.7180, 32.4857],
  ["PGH", "Pantnagar Airport", "Pantnagar", "India", "Asia/Kolkata", 29.0334, 79.4737],
  ["PHC", "Port Harcourt International Airport", "Port Harcourt", "Nigeria", "Africa/Lagos", 5.0155, 6.9496],
  ["PHE", "Port Hedland International Airport", "Port Hedland", "Australia", "Australia/Perth", -20.3828, 118.6298],
  ["PHH", "Pokhara International Airport", "Pokhara", "Nepal", "Asia/Kathmandu", 28.1838, 84.0147],
  ["PHL", "Philadelphia International Airport", "Philadelphia", "United States", "America/New_York", 39.8719, -75.2411],
  ["PHX", "Phoenix Sky Harbor International Airport", "Phoenix", "United States", "America/Phoenix", 33.4353, -112.0059],
  ["PIE", "St. Petersburg Clearwater International Airport", "Pinellas Park", "United States", "America/New_York", 27.9102, -82.6874],
  ["PIK", "Glasgow Prestwick Airport", "Prestwick", "United Kingdom", "Europe/London", 55.5015, -4.5772, "glasgow prestwick airport prestwick south ayrshire"],
  ["PIT", "Pittsburgh International Airport", "Pittsburgh", "United States", "America/New_York", 40.4915, -80.2329],
  ["PKC", "Yelizovo Airport", "Petropavlovsk-Kamchatsky", "Russia", "Asia/Kamchatka", 53.1687, 158.4511],
  ["PKX", "Beijing Daxing International Airport", "Beijing", "China", "Asia/Shanghai", 39.5013, 116.4140],
  ["PKZ", "Pakse International Airport", "Pakse", "Laos", "Asia/Vientiane", 15.1340, 105.7799],
  ["PLQ", "Palanga International Airport", "Palanga", "Lithuania", "Europe/Vilnius", 55.9732, 21.0939],
  ["PLS", "Providenciales International Airport", "Providenciales", "Turks and Caicos Islands", "America/Grand_Turk", 21.7737, -72.2683],
  ["PLX", "Semei International Airport", "Semey", "Kazakhstan", "Asia/Almaty", 50.3513, 80.2344],
  ["PLZ", "Chief Dawid Stuurman International Airport", "Gqeberha", "South Africa", "Africa/Johannesburg", -33.9897, 25.6174, "chief dawid stuurman international airport gqeberha port elizabeth"],
  ["PMC", "El Tepual International Airport", "Puerto Montt", "Chile", "America/Santiago", -41.4431, -73.0941],
  ["PMI", "Palma de Mallorca Airport", "Palma de Mallorca", "Spain", "Europe/Madrid", 39.5517, 2.7388],
  ["PMO", "Falcone–Borsellino Airport", "Palermo", "Italy", "Europe/Rome", 38.1760, 13.0910],
  ["PMV", "Del Caribe Santiago Mariño International Airport", "Isla Margarita", "Venezuela", "America/Caracas", 10.9126, -63.9666, "del caribe santiago mariño international airport isla margarita del caribe santiago marino international airport isla margarita"],
  ["PNK", "Supadio International Airport", "Pontianak", "Indonesia", "Asia/Pontianak", -0.1523, 109.4045],
  ["PNQ", "Pune International Airport", "Pune", "India", "Asia/Kolkata", 18.5821, 73.9197, "pune international airport pune poona"],
  ["PNR", "Antonio Agostinho-Neto International Airport", "Pointe Noire", "Republic of the Congo", "Africa/Brazzaville", -4.8160, 11.8866],
  ["PNS", "Pensacola International Airport", "Pensacola", "United States", "America/Chicago", 30.4727, -87.1866],
  ["PNY", "Pondicherry Airport", "Puducherry", "India", "Asia/Kolkata", 11.9680, 79.8120],
  ["POA", "Porto Alegre-Salgado Filho International Airport", "Porto Alegre", "Brazil", "America/Sao_Paulo", -29.9940, -51.1675],
  ["POG", "Port Gentil International Airport", "Port Gentil", "Gabon", "Africa/Libreville", -0.7117, 8.7544],
  ["POM", "Port Moresby Jacksons International Airport", "Port Moresby", "Papua New Guinea", "Pacific/Port_Moresby", -9.4434, 147.2200],
  ["POS", "Piarco International Airport", "Port of Spain", "Trinidad and Tobago", "America/Port_of_Spain", 10.5953, -61.3376],
  ["POZ", "Poznań-Ławica Airport", "Poznań", "Poland", "Europe/Warsaw", 52.4216, 16.8234, "poznań ławica airport poznań poznan ławica airport poznan"],
  ["PPG", "Pago Pago International Airport", "Pago Pago", "American Samoa", "Pacific/Pago_Pago", -14.3310, -170.7100],
  ["PPK", "Petropavl International Airport", "Petropavl", "Kazakhstan", "Asia/Almaty", 54.7756, 69.1874],
  ["PPS", "Puerto Princesa International Airport / PAF Antonio Bautista Air Base", "Puerto Princesa", "Philippines", "Asia/Manila", 9.7420, 118.7591],
  ["PPT", "Fa'a'ā International Airport", "Papeete", "French Polynesia", "Pacific/Tahiti", -17.5535, -149.6069, "fa a ā international airport papeete fa a a international airport papeete"],
  ["PQC", "Phú Quốc International Airport", "Phu Quoc Island", "Vietnam", "Asia/Ho_Chi_Minh", 10.1698, 103.9935, "phú qu c international airport phu quoc island phu qu c international airport phu quoc island"],
  ["PRG", "Václav Havel Airport Prague", "Prague", "Czech Republic", "Europe/Prague", 50.1009, 14.2599, "václav havel airport prague prague vaclav havel airport prague prague"],
  ["PRN", "Priština Adem Jashari International Airport", "Prishtina", "Kosovo", "Europe/Belgrade", 42.5728, 21.0358, "priština adem jashari international airport prishtina pristina adem jashari international airport prishtina"],
  ["PSA", "Pisa International Airport", "Pisa", "Italy", "Europe/Rome", 43.6839, 10.3927, "pisa international airport pisa pi"],
  ["PSD", "Port Said International Airport", "Port Said", "Egypt", "Africa/Cairo", 31.2793, 32.2406],
  ["PSP", "Palm Springs International Airport", "Palm Springs", "United States", "America/Los_Angeles", 33.8297, -116.5070],
  ["PSR", "Abruzzo Airport", "Pescara", "Italy", "Europe/Rome", 42.4311, 14.1830],
  ["PTG", "Polokwane International Airport", "Polokwane", "South Africa", "Africa/Johannesburg", -23.8453, 29.4586],
  ["PTP", "Maryse Condé International Airport", "Pointe-à-Pitre", "Guadeloupe", "America/Guadeloupe", 16.2654, -61.5328, "maryse condé international airport pointe à pitre maryse conde international airport pointe a pitre"],
  ["PTY", "Tocumen International Airport", "Tocumen", "Panama", "America/Panama", 9.0714, -79.3835],
  ["PUJ", "Punta Cana International Airport", "Punta Cana", "Dominican Republic", "America/Santo_Domingo", 18.5671, -68.3646],
  ["PUQ", "President Carlos Ibáñez International Airport", "Punta Arenas", "Chile", "America/Punta_Arenas", -53.0026, -70.8546, "president carlos ibáñez international airport punta arenas president carlos ibanez international airport punta arenas"],
  ["PUS", "Gimhae International Airport", "Busan", "South Korea", "Asia/Seoul", 35.1795, 128.9380],
  ["PUY", "Pula Airport", "Pula", "Croatia", "Europe/Zagreb", 44.8935, 13.9222],
  ["PVD", "Rhode Island T. F. Green International Airport", "Providence/Warwick", "United States", "America/New_York", 41.7250, -71.4257],
  ["PVG", "Shanghai Pudong International Airport", "Shanghai", "China", "Asia/Shanghai", 31.1434, 121.8050],
  ["PVH", "Governador Jorge Teixeira de Oliveira International Airport", "Porto Velho", "Brazil", "America/Porto_Velho", -8.7085, -63.9023],
  ["PVR", "Puerto Vallarta International Airport", "Puerto Vallarta", "Mexico", "America/Bahia_Banderas", 20.6799, -105.2544],
  ["PWM", "Portland International Jetport", "Portland", "United States", "America/New_York", 43.6462, -70.3093],
  ["PWQ", "Pavlodar International Airport", "Pavlodar", "Kazakhstan", "Asia/Almaty", 52.1950, 77.0731],
  ["PYK", "Payam International Airport", "Karaj", "Iran", "Asia/Tehran", 35.7761, 50.8267],
  ["PZO", "General Manuel Carlos Piar International Airport", "Guyana City", "Venezuela", "America/Caracas", 8.2885, -62.7604],
  ["PZU", "Port Sudan New International Airport", "Port Sudan", "Sudan", "Africa/Khartoum", 19.4346, 37.2341],
  ["QRO", "Querétaro Intercontinental Airport", "Querétaro", "Mexico", "America/Mexico_City", 20.6188, -100.1864, "querétaro intercontinental airport querétaro queretaro intercontinental airport queretaro"],
  ["RAI", "Nelson Mandela International Airport", "Praia", "Cape Verde", "Atlantic/Cape_Verde", 14.9411, -23.4847],
  ["RAK", "Marrakesh Menara Airport", "Marrakesh", "Morocco", "Africa/Casablanca", 31.6048, -8.0358, "marrakesh menara airport marrakesh marrakech"],
  ["RAR", "Rarotonga International Airport", "Avarua", "Cook Islands", "Pacific/Rarotonga", -21.2027, -159.8060],
  ["RBA", "Rabat-Salé Airport", "Rabat", "Morocco", "Africa/Casablanca", 34.0515, -6.7515, "rabat salé airport rabat rabat sale airport rabat"],
  ["RBR", "Rio Branco-Plácido de Castro International Airport", "Rio Branco", "Brazil", "America/Rio_Branco", -9.8690, -67.8940, "rio branco plácido de castro international airport rio branco rio branco placido de castro international airport rio branco"],
  ["RDP", "Kazi Nazrul Islam Airport", "Durgapur", "India", "Asia/Kolkata", 23.6225, 87.2430],
  ["RDU", "Raleigh-Durham International Airport", "Raleigh/Durham", "United States", "America/New_York", 35.8787, -78.7873],
  ["REC", "Recife/Guararapes - Gilberto Freyre International Airport", "Recife", "Brazil", "America/Recife", -8.1275, -34.9230],
  ["RES", "Resistencia International Airport", "Resistencia", "Argentina", "America/Argentina/Cordoba", -27.4499, -59.0561],
  ["REU", "Reus Airport", "Reus", "Spain", "Europe/Madrid", 41.1475, 1.1684],
  ["REW", "Rewa Airport, Chorhata, REWA", "Rewa", "India", "Asia/Kolkata", 24.5034, 81.2203],
  ["RGL", "Piloto Civil Norberto Fernández International Airport", "Rio Gallegos", "Argentina", "America/Argentina/Rio_Gallegos", -51.6088, -69.3089, "piloto civil norberto fernández international airport rio gallegos piloto civil norberto fernandez international airport rio gallegos"],
  ["RGN", "Yangon International Airport", "Yangon", "Myanmar", "Asia/Yangon", 16.9073, 96.1332, "yangon international airport yangon rangoon"],
  ["RHO", "Rhodes International Airport \"Diagoras\"", "Rhodes", "Greece", "Europe/Athens", 36.4054, 28.0862],
  ["RIC", "Richmond International Airport", "Richmond", "United States", "America/New_York", 37.5052, -77.3197],
  ["RIX", "Riga International Airport", "Riga", "Latvia", "Europe/Riga", 56.9208, 23.9707],
  ["RIY", "Riyan International Airport", "Mukalla", "Yemen", "Asia/Aden", 14.6622, 49.3753],
  ["RJA", "Rajahmundry Airport", "Rajahmundry", "India", "Asia/Kolkata", 17.1058, 81.8132, "rajahmundry airport rajahmundry madhurapudi"],
  ["RJK", "Rijeka Airport", "Rijeka", "Croatia", "Europe/Zagreb", 45.2164, 14.5709, "rijeka airport rijeka omišalj rijeka airport rijeka omisalj"],
  ["RKT", "Ras Al Khaimah International Airport", "Ras Al Khaimah", "United Arab Emirates", "Asia/Dubai", 25.6135, 55.9388],
  ["RKZ", "Xigaze Peace Airport / Shigatse Air Base", "Xigazê", "China", "Asia/Shanghai", 29.3509, 89.2992, "xigaze peace airport shigatse air base xigazê samzhubzê xigaze peace airport shigatse air base xigaze samzhubze"],
  ["RMF", "Marsa Alam International Airport", "Marsa Alam", "Egypt", "Africa/Cairo", 25.5555, 34.5924],
  ["RMI", "Federico Fellini International Airport", "Rimini", "Italy", "Europe/Rome", 44.0200, 12.6122, "federico fellini international airport rimini rn"],
  ["RML", "Colombo Ratmalana International Airport", "Colombo", "Sri Lanka", "Asia/Colombo", 6.8216, 79.8859],
  ["RMO", "Chişinău International Airport", "Chişinău", "Moldova", "Europe/Chisinau", 46.9277, 28.9317, "chişinău international airport chişinău chisinau international airport chisinau"],
  ["RMQ", "Taichung International Airport / Ching Chuang Kang Air Base", "Taichung", "Taiwan", "Asia/Taipei", 24.2647, 120.6210, "taichung international airport ching chuang kang air base taichung qingshui"],
  ["RMU", "Region of Murcia International Airport", "Corvera", "Spain", "Europe/Madrid", 37.8029, -1.1249],
  ["RNO", "Reno Tahoe International Airport", "Reno", "United States", "America/Los_Angeles", 39.4991, -119.7680],
  ["ROB", "Roberts International Airport", "Monrovia", "Liberia", "Africa/Monrovia", 6.2338, -10.3623],
  ["ROC", "Frederick Douglass Greater Rochester International Airport", "Rochester", "United States", "America/New_York", 43.1189, -77.6724],
  ["ROP", "Rota International Airport", "Rota Island", "Northern Mariana Islands", "Pacific/Saipan", 14.1733, 145.2411],
  ["ROR", "Roman Tmetuchl International Airport", "Babelthuap Island", "Palau", "Pacific/Palau", 7.3670, 134.5441],
  ["ROS", "Rosario Islas Malvinas International Airport", "Rosario", "Argentina", "America/Argentina/Cordoba", -32.9036, -60.7850],
  ["RPR", "Swami Vivekananda Airport", "Raipur", "India", "Asia/Kolkata", 21.1804, 81.7388],
  ["RSI", "Red Sea International Airport", "Hanak", "Saudi Arabia", "Asia/Riyadh", 25.6280, 37.0889],
  ["RSW", "Southwest Florida International Airport", "Fort Myers", "United States", "America/New_York", 26.5347, -81.7528],
  ["RTB", "Juan Manuel Gálvez International Airport", "Coxen Hole", "Honduras", "America/Tegucigalpa", 16.3168, -86.5230, "juan manuel gálvez international airport coxen hole juan manuel galvez international airport coxen hole"],
  ["RTM", "Rotterdam The Hague Airport", "Rotterdam", "Netherlands", "Europe/Amsterdam", 51.9569, 4.4372],
  ["RUH", "King Khalid International Airport", "Riyadh", "Saudi Arabia", "Asia/Riyadh", 24.9576, 46.6988],
  ["RUN", "Roland Garros Airport", "Sainte-Marie", "Réunion", "Indian/Reunion", -20.8901, 55.5189],
  ["RVN", "Rovaniemi Airport", "Rovaniemi", "Finland", "Europe/Helsinki", 66.5633, 25.8298],
  ["RZE", "Rzeszów-Jasionka Airport", "Jasionka", "Poland", "Europe/Warsaw", 50.1098, 22.0242, "rzeszów jasionka airport jasionka rzeszow jasionka airport jasionka"],
  ["RZV", "Rize–Artvin Airport", "Rize", "Turkey", "Europe/Istanbul", 41.1798, 40.8488],
  ["SAG", "Shirdi International Airport", "Shirdi", "India", "Asia/Kolkata", 19.6892, 74.3737, "shirdi international airport shirdi kakadi"],
  ["SAH", "Sanaa International Airport", "Sanaa", "Yemen", "Asia/Aden", 15.4763, 44.2197],
  ["SAI", "Siem Reap-Angkor International Airport", "Siem Reap", "Cambodia", "Asia/Phnom_Penh", 13.3697, 104.2238],
  ["SAL", "El Salvador International Airport Saint Óscar Arnulfo Romero y Galdámez", "San Salvador", "El Salvador", "America/El_Salvador", 13.4445, -89.0558, "el salvador international airport saint óscar arnulfo romero y galdámez san salvador luis talpa el salvador international airport saint oscar arnulfo romero y galdamez san salvador luis talpa"],
  ["SAN", "San Diego International Airport", "San Diego", "United States", "America/Los_Angeles", 32.7336, -117.1900],
  ["SAP", "Ramón Villeda Morales International Airport", "San Pedro Sula", "Honduras", "America/Tegucigalpa", 15.4526, -87.9236, "ramón villeda morales international airport san pedro sula ramon villeda morales international airport san pedro sula"],
  ["SAT", "San Antonio International Airport", "San Antonio", "United States", "America/Chicago", 29.5337, -98.4698],
  ["SAV", "Savannah Hilton Head International Airport", "Savannah", "United States", "America/New_York", 32.1266, -81.2000],
  ["SAW", "Istanbul Sabiha Gökçen International Airport", "Istanbul", "Turkey", "Europe/Istanbul", 40.8986, 29.3092, "istanbul sabiha gökçen international airport istanbul pendik istanbul sabiha gokcen international airport istanbul pendik"],
  ["SBD", "San Bernardino International Airport", "San Bernardino", "United States", "America/Los_Angeles", 34.0967, -117.2366],
  ["SBZ", "Sibiu International Airport", "Sibiu", "Romania", "Europe/Bucharest", 45.7858, 24.0867],
  ["SCL", "Comodoro Arturo Merino Benítez International Airport", "Santiago", "Chile", "America/Santiago", -33.3930, -70.7858, "comodoro arturo merino benítez international airport santiago comodoro arturo merino benitez international airport santiago"],
  ["SCO", "Aktau International Airport", "Aktau", "Kazakhstan", "Asia/Aqtau", 43.8601, 51.0909],
  ["SCQ", "Santiago-Rosalía de Castro Airport", "Santiago de Compostela", "Spain", "Europe/Madrid", 42.8963, -8.4151, "santiago rosalía de castro airport santiago de compostela santiago rosalia de castro airport santiago de compostela"],
  ["SCR", "Scandinavian Mountains Airport", "Malung-Sälen", "Sweden", "Europe/Stockholm", 61.1651, 12.8335, "scandinavian mountains airport malung sälen scandinavian mountains airport malung salen"],
  ["SCU", "Antonio Maceo International Airport", "Santiago", "Cuba", "America/Havana", 19.9747, -75.8355],
  ["SCV", "Suceava Ștefan cel Mare International Airport", "Suceava", "Romania", "Europe/Bucharest", 47.6875, 26.3541, "suceava ștefan cel mare international airport suceava suceava stefan cel mare international airport suceava"],
  ["SDF", "Louisville Muhammad Ali International Airport", "Louisville", "United States", "America/Kentucky/Louisville", 38.1706, -85.7351],
  ["SDJ", "Sendai Airport", "Natori", "Japan", "Asia/Tokyo", 38.1397, 140.9170],
  ["SDQ", "Las Américas International Airport", "Santo Domingo", "Dominican Republic", "America/Santo_Domingo", 18.4297, -69.6689, "las américas international airport santo domingo las americas international airport santo domingo"],
  ["SDU", "Santos Dumont Airport", "Rio de Janeiro", "Brazil", "America/Sao_Paulo", -22.9104, -43.1628],
  ["SDW", "Sindhudurg Airport", "Sindhudurg", "India", "Asia/Kolkata", 16.0026, 73.5298, "sindhudurg airport sindhudurg chipi"],
  ["SEA", "Seattle–Tacoma International Airport", "Seattle", "United States", "America/Los_Angeles", 47.4479, -122.3103],
  ["SEZ", "Seychelles International Airport", "Victoria", "Seychelles", "Indian/Mahe", -4.6743, 55.5218],
  ["SFB", "Orlando Sanford International Airport", "Orlando", "United States", "America/New_York", 28.7743, -81.2346],
  ["SFO", "San Francisco International Airport", "San Francisco", "United States", "America/Los_Angeles", 37.6198, -122.3748],
  ["SFS", "Subic Bay International Airport / Naval Air Station Cubi Point", "Olongapo", "Philippines", "Asia/Manila", 14.7948, 120.2719],
  ["SGC", "Surgut International Airport", "Surgut", "Russia", "Asia/Yekaterinburg", 61.3405, 73.4058],
  ["SGN", "Tan Son Nhat International Airport", "Ho Chi Minh City", "Vietnam", "Asia/Ho_Chi_Minh", 10.8188, 106.6520, "tan son nhat international airport ho chi minh city saigon"],
  ["SHA", "Shanghai Hongqiao International Airport", "Shanghai", "China", "Asia/Shanghai", 31.1981, 121.3343, "shanghai hongqiao international airport shanghai minhang"],
  ["SHE", "Shenyang Taoxian International Airport", "Shenyang", "China", "Asia/Shanghai", 41.6398, 123.4837],
  ["SHJ", "Sharjah International Airport", "Sharjah", "United Arab Emirates", "Asia/Dubai", 25.3286, 55.5172],
  ["SHL", "Shillong Airport", "Shillong", "India", "Asia/Kolkata", 25.7036, 91.9787],
  ["SHO", "King Mswati III International Airport", "Mpaka", "Eswatini", "Africa/Mbabane", -26.3586, 31.7169],
  ["SID", "Amílcar Cabral International Airport", "Espargos", "Cape Verde", "Atlantic/Cape_Verde", 16.7414, -22.9494, "amílcar cabral international airport espargos amilcar cabral international airport espargos"],
  ["SIN", "Singapore Changi Airport", "Singapore", "Singapore", "Asia/Singapore", 1.3502, 103.9940],
  ["SJC", "Mineta San Jose International Airport", "San Jose", "United States", "America/Los_Angeles", 37.3625, -121.9292, "mineta san jose international airport san jose francisco"],
  ["SJD", "Los Cabos International Airport", "San José del Cabo", "Mexico", "America/Mazatlan", 23.1519, -109.7207, "los cabos international airport san josé del cabo los cabos international airport san jose del cabo"],
  ["SJJ", "Sarajevo International Airport", "Sarajevo", "Bosnia and Herzegovina", "Europe/Sarajevo", 43.8246, 18.3315],
  ["SJO", "Juan Santamaría International Airport", "San José", "Costa Rica", "America/Costa_Rica", 9.9939, -84.2088, "juan santamaría international airport san josé alajuela juan santamaria international airport san jose alajuela"],
  ["SJU", "Luis Munoz Marin International Airport", "San Juan", "Puerto Rico", "America/Puerto_Rico", 18.4394, -66.0018],
  ["SJW", "Shijiazhuang Zhengding International Airport", "Shijiazhuang", "China", "Asia/Shanghai", 38.2807, 114.6970],
  ["SKB", "Robert L. Bradshaw International Airport", "Basseterre", "Saint Kitts and Nevis", "America/St_Kitts", 17.3108, -62.7191],
  ["SKD", "Samarkand International Airport", "Samarkand", "Uzbekistan", "Asia/Samarkand", 39.7018, 66.9815],
  ["SKG", "Thessaloniki Macedonia International Airport", "Thessaloniki", "Greece", "Europe/Athens", 40.5193, 22.9700],
  ["SKO", "Sadiq Abubakar III International Airport", "Sokoto", "Nigeria", "Africa/Lagos", 12.9157, 5.2075],
  ["SKP", "Skopje International Airport", "Ilinden", "North Macedonia", "Europe/Skopje", 41.9581, 21.6226],
  ["SKT", "Sialkot International Airport", "Sialkot", "Pakistan", "Asia/Karachi", 32.5359, 74.3646],
  ["SKX", "Saransk International Airport", "Saransk", "Russia", "Europe/Moscow", 54.1251, 45.2123],
  ["SLA", "Martín Miguel de Güemes International Airport", "Salta", "Argentina", "America/Argentina/Salta", -24.8560, -65.4862, "martín miguel de güemes international airport salta martin miguel de guemes international airport salta"],
  ["SLC", "Salt Lake City International Airport", "Salt Lake City", "United States", "America/Denver", 40.7889, -111.9799],
  ["SLL", "Salalah International Airport", "Salalah", "Oman", "Asia/Muscat", 17.0387, 54.0913],
  ["SLZ", "Marechal Cunha Machado International Airport", "São Luís", "Brazil", "America/Fortaleza", -2.5864, -44.2350, "marechal cunha machado international airport são luís marechal cunha machado international airport sao luis"],
  ["SMF", "Sacramento International Airport", "Sacramento", "United States", "America/Los_Angeles", 38.6954, -121.5910],
  ["SNA", "John Wayne Orange County International Airport", "Santa Ana", "United States", "America/Los_Angeles", 33.6751, -117.8693],
  ["SNC", "General Ulpiano Paez International Airport", "Salinas/La Libertad", "Ecuador", "America/Guayaquil", -2.2101, -80.9851],
  ["SNN", "Shannon Airport", "Shannon", "Ireland", "Europe/Dublin", 52.7020, -8.9248],
  ["SNU", "Abel Santamaria International Airport", "Santa Clara", "Cuba", "America/Havana", 22.4922, -79.9431],
  ["SOC", "Adisoemarmo International Airport", "Surakarta", "Indonesia", "Asia/Jakarta", -7.5160, 110.7575],
  ["SOF", "Sofia Airport", "Sofia", "Bulgaria", "Europe/Sofia", 42.6964, 23.4177],
  ["SPU", "Split Saint Jerome Airport", "Split", "Croatia", "Europe/Zagreb", 43.5389, 16.2980],
  ["SPX", "Sphinx International Airport", "Al Jiza", "Egypt", "Africa/Cairo", 30.1082, 30.8957],
  ["SRE", "Alcantarí International Airport", "Sucre", "Bolivia", "America/La_Paz", -19.2468, -65.1496, "alcantarí international airport sucre alcantari international airport sucre"],
  ["SRG", "Jenderal Ahmad Yani Airport", "Semarang", "Indonesia", "Asia/Jakarta", -6.9707, 110.3732],
  ["SRQ", "Sarasota Bradenton International Airport", "Sarasota/Bradenton", "United States", "America/New_York", 27.3946, -82.5544],
  ["SSA", "Deputado Luiz Eduardo Magalhães International Airport", "Salvador", "Brazil", "America/Bahia", -12.9086, -38.3225, "deputado luiz eduardo magalhães international airport salvador deputado luiz eduardo magalhaes international airport salvador"],
  ["SSG", "Malabo International Airport", "Malabo", "Equatorial Guinea", "Africa/Malabo", 3.7553, 8.7087],
  ["SSH", "Sharm El Sheikh International Airport", "Sharm El Sheikh", "Egypt", "Africa/Cairo", 27.9773, 34.3947],
  ["STI", "Cibao International Airport", "Santiago", "Dominican Republic", "America/Santo_Domingo", 19.4041, -70.6044],
  ["STL", "St. Louis Lambert International Airport", "St Louis", "United States", "America/Chicago", 38.7487, -90.3700],
  ["STN", "London Stansted Airport", "London", "United Kingdom", "Europe/London", 51.8850, 0.2350, "london stansted airport london essex"],
  ["STR", "Stuttgart Airport", "Stuttgart", "Germany", "Europe/Berlin", 48.6899, 9.2220],
  ["STT", "Cyril E. King Airport", "Charlotte Amalie", "U.S. Virgin Islands", "America/St_Thomas", 18.3371, -64.9773],
  ["STV", "Surat International Airport", "Surat", "India", "Asia/Kolkata", 21.1155, 72.7433],
  ["SUB", "Juanda International Airport", "Surabaya", "Indonesia", "Asia/Jakarta", -7.3798, 112.7870],
  ["SUF", "Lamezia Terme Sant'Eufemia International Airport", "Lamezia Terme", "Italy", "Europe/Rome", 38.9062, 16.2460, "lamezia terme sant eufemia international airport lamezia terme cz"],
  ["SUV", "Nausori International Airport", "Nausori", "Fiji", "Pacific/Fiji", -18.0442, 178.5615],
  ["SVD", "Argyle International Airport", "Kingstown", "Saint Vincent and the Grenadines", "America/St_Vincent", 13.1597, -61.1488],
  ["SVG", "Stavanger Airport, Sola", "Stavanger", "Norway", "Europe/Oslo", 58.8767, 5.6378],
  ["SVO", "Sheremetyevo International Airport", "Moscow", "Russia", "Europe/Moscow", 55.9769, 37.4112],
  ["SVQ", "Seville Airport", "Seville", "Spain", "Europe/Madrid", 37.4180, -5.8931],
  ["SVX", "Koltsovo Airport", "Yekaterinburg", "Russia", "Asia/Yekaterinburg", 56.7431, 60.8027],
  ["SWA", "Jieyang Chaoshan International Airport", "Jieyang", "China", "Asia/Shanghai", 23.5520, 116.5033, "jieyang chaoshan international airport jieyang rongcheng"],
  ["SXB", "Strasbourg Airport", "Strasbourg", "France", "Europe/Paris", 48.5383, 7.6282],
  ["SXM", "Princess Juliana International Airport", "Sint Maarten", "Sint Maarten", "America/Lower_Princes", 18.0410, -63.1089],
  ["SXR", "Srinagar International Airport", "Srinagar", "India", "Asia/Kolkata", 33.9871, 74.7742],
  ["SYD", "Sydney Kingsford Smith International Airport", "Sydney", "Australia", "Australia/Sydney", -33.9461, 151.1770, "sydney kingsford smith international airport sydney mascot"],
  ["SYR", "Syracuse Hancock International Airport", "Syracuse", "United States", "America/New_York", 43.1112, -76.1063],
  ["SYX", "Sanya Phoenix International Airport", "Sanya", "China", "Asia/Shanghai", 18.3029, 109.4120, "sanya phoenix international airport sanya tianya"],
  ["SYZ", "Shiraz Shahid Dastghaib International Airport", "Shiraz", "Iran", "Asia/Tehran", 29.5392, 52.5898],
  ["SZB", "Sultan Abdul Aziz Shah International Airport", "Subang", "Malaysia", "Asia/Kuala_Lumpur", 3.1306, 101.5490, "sultan abdul aziz shah international airport subang kuala lumpur"],
  ["SZG", "Salzburg Airport", "Salzburg", "Austria", "Europe/Berlin", 47.7933, 13.0043],
  ["SZX", "Shenzhen Bao'an International Airport", "Shenzhen", "China", "Asia/Shanghai", 22.6395, 113.8033],
  ["SZZ", "Solidarity Szczecin–Goleniów Airport", "Szczecin", "Poland", "Europe/Warsaw", 53.5847, 14.9022, "solidarity szczecin goleniów airport szczecin glewice solidarity szczecin goleniow airport szczecin glewice"],
  ["TAB", "A.N.R. Robinson International Airport", "Scarborough", "Trinidad and Tobago", "America/Port_of_Spain", 11.1496, -60.8313],
  ["TAE", "Daegu International Airport", "Daegu", "South Korea", "Asia/Seoul", 35.8944, 128.6570],
  ["TAG", "Bohol-Panglao International Airport", "Panglao", "Philippines", "Asia/Manila", 9.5730, 123.7701],
  ["TAK", "Takamatsu Airport", "Takamatsu", "Japan", "Asia/Tokyo", 34.2150, 134.0155],
  ["TAO", "Qingdao Jiaodong International Airport", "Qingdao", "China", "Asia/Shanghai", 36.3620, 120.0882, "qingdao jiaodong international airport qingdao jiaozhou"],
  ["TAS", "Tashkent International Airport", "Tashkent", "Uzbekistan", "Asia/Tashkent", 41.2579, 69.2812],
  ["TAZ", "Dashoguz International Airport", "Daşoguz", "Turkmenistan", "Asia/Ashgabat", 41.7599, 59.8361, "dashoguz international airport daşoguz dashoguz international airport dasoguz"],
  ["TBS", "Tbilisi International Airport", "Tbilisi", "Georgia", "Asia/Tbilisi", 41.6692, 44.9547],
  ["TBU", "Fua'amotu International Airport", "Nuku'alofa", "Tonga", "Pacific/Tongatapu", -21.2414, -175.1492],
  ["TBZ", "Tabriz International Airport", "Tabriz", "Iran", "Asia/Tehran", 38.1339, 46.2350],
  ["TCR", "Tuticorin Airport", "Tuticorin", "India", "Asia/Kolkata", 8.7242, 78.0258, "tuticorin airport tuticorin thoothukudi vagaikulam"],
  ["TET", "Tete Airport", "Tete", "Mozambique", "Africa/Maputo", -16.1048, 33.6402],
  ["TEZ", "Tezpur Airport", "Tezpur Airport", "India", "Asia/Kolkata", 26.7091, 92.7847],
  ["TFN", "Tenerife Norte-Ciudad de La Laguna Airport", "Tenerife", "Spain", "Atlantic/Canary", 28.4828, -16.3417],
  ["TFS", "Tenerife Sur Airport", "Tenerife", "Spain", "Atlantic/Canary", 28.0445, -16.5725],
  ["TFU", "Chengdu Tianfu International Airport", "Chengdu", "China", "Asia/Shanghai", 30.3125, 104.4413, "chengdu tianfu international airport chengdu jianyang"],
  ["TGD", "Podgorica Airport / Podgorica Golubovci Airbase", "Podgorica", "Montenegro", "Europe/Podgorica", 42.3594, 19.2519],
  ["THR", "Mehrabad International Airport", "Tehran", "Iran", "Asia/Tehran", 35.6892, 51.3144],
  ["TIA", "Tirana International Airport Mother Teresa", "Rinas", "Albania", "Europe/Tirane", 41.4147, 19.7206],
  ["TIF", "Taif International Airport", "Taif", "Saudi Arabia", "Asia/Riyadh", 21.4847, 40.5441],
  ["TIJ", "General Abelardo L. Rodriguez International Airport", "Tijuana", "Mexico", "America/Los_Angeles", 32.5410, -116.9700],
  ["TIR", "Tirupati International Airport", "Tirupati", "India", "Asia/Kolkata", 13.6320, 79.5399],
  ["TJM", "Roshchino International Airport", "Tyumen", "Russia", "Asia/Yekaterinburg", 57.1790, 65.3277],
  ["TJU", "Kulob International Airport", "Kulob", "Tajikistan", "Asia/Dushanbe", 37.9881, 69.8050],
  ["TKK", "Chuuk International Airport", "Weno Island", "Micronesia", "Pacific/Chuuk", 7.4619, 151.8430],
  ["TKS", "Tokushima Awaodori Airport / JMSDF Tokushima Air Base", "Tokushima", "Japan", "Asia/Tokyo", 34.1326, 134.6078],
  ["TKU", "Turku Airport", "Turku", "Finland", "Europe/Helsinki", 60.5141, 22.2628],
  ["TLC", "Adolfo López Mateos International Airport", "Toluca", "Mexico", "America/Mexico_City", 19.3369, -99.5658, "adolfo lópez mateos international airport toluca adolfo lopez mateos international airport toluca"],
  ["TLL", "Lennart Meri Tallinn Airport", "Tallinn", "Estonia", "Europe/Tallinn", 59.4132, 24.8326],
  ["TLM", "Zenata – Messali El Hadj Airport", "Zenata", "Algeria", "Africa/Algiers", 35.0127, -1.4571],
  ["TLS", "Toulouse-Blagnac Airport", "Toulouse/Blagnac", "France", "Europe/Paris", 43.6291, 1.3638],
  ["TLV", "Ben Gurion International Airport", "Tel Aviv", "Israel", "Asia/Jerusalem", 32.0114, 34.8867],
  ["TML", "Yakubu Tali International Airport", "Tamale", "Ghana", "Africa/Accra", 9.5539, -0.8661],
  ["TMM", "Toamasina Ambalamanasy Airport", "Toamasina", "Madagascar", "Indian/Antananarivo", -18.1135, 49.3923],
  ["TMP", "Tampere-Pirkkala Airport", "Tampere / Pirkkala", "Finland", "Europe/Helsinki", 61.4141, 23.6044],
  ["TMR", "Aguenar – Hadj Bey Akhamok Airport", "Tamanrasset", "Algeria", "Africa/Algiers", 22.8110, 5.4508],
  ["TMS", "São Tomé International Airport", "São Tomé", "São Tomé and Principe", "Africa/Sao_Tome", 0.3782, 6.7122, "são tomé international airport são tomé sao tome international airport sao tome"],
  ["TNA", "Jinan Yaoqiang International Airport", "Jinan", "China", "Asia/Shanghai", 36.8572, 117.2160, "jinan yaoqiang international airport jinan licheng"],
  ["TNG", "Tangier Ibn Battuta Airport", "Tangier", "Morocco", "Africa/Casablanca", 35.7317, -5.9215],
  ["TNN", "Tainan International Airport / Tainan Air Base", "Tainan", "Taiwan", "Asia/Taipei", 22.9504, 120.2060, "tainan international airport tainan air base tainan rende"],
  ["TNR", "Ivato International Airport", "Antananarivo", "Madagascar", "Indian/Antananarivo", -18.7969, 47.4788],
  ["TOF", "Tomsk Kamov Airport", "Tomsk", "Russia", "Asia/Tomsk", 56.3803, 85.2083],
  ["TOM", "Tombouktou Airport", "Timbuktu", "Mali", "Africa/Bamako", 16.7305, -3.0076],
  ["TOS", "Tromsø Airport", "Tromsø", "Norway", "Europe/Oslo", 69.6833, 18.9189],
  ["TPA", "Tampa International Airport", "Tampa", "United States", "America/New_York", 27.9755, -82.5332],
  ["TPE", "Taiwan Taoyuan International Airport", "Taipei", "Taiwan", "Asia/Taipei", 25.0777, 121.2330],
  ["TQO", "Felipe Carrillo Puerto International Airport Tulum", "Tulum", "Mexico", "America/Cancun", 20.1721, -87.6603],
  ["TRD", "Trondheim Airport, Værnes", "Trondheim", "Norway", "Europe/Oslo", 63.4578, 10.9240],
  ["TRF", "Sandefjord Airport, Torp", "Sandefjord", "Norway", "Europe/Oslo", 59.1867, 10.2586, "sandefjord airport torp sandefjord oslo"],
  ["TRN", "Turin Airport", "Caselle Torinese", "Italy", "Europe/Rome", 45.2008, 7.6496, "turin airport caselle torinese to"],
  ["TRS", "Trieste Airport", "Ronchi dei Legionari/Trieste", "Italy", "Europe/Rome", 45.8279, 13.4667],
  ["TRU", "Capitán FAP Carlos Martínez de Pinillos International Airport", "Trujillo", "Peru", "America/Lima", -8.0824, -79.1088, "capitán fap carlos martínez de pinillos international airport trujillo capitan fap carlos martinez de pinillos international airport trujillo"],
  ["TRV", "Thiruvananthapuram International Airport", "Thiruvananthapuram", "India", "Asia/Kolkata", 8.4819, 76.9200, "thiruvananthapuram international airport thiruvananthapuram trivandrum"],
  ["TRW", "Bonriki International Airport", "South Tarawa", "Kiribati", "Pacific/Tarawa", 1.3816, 173.1470],
  ["TRZ", "Tiruchirappalli International Airport", "Tiruchirappalli", "India", "Asia/Kolkata", 10.7629, 78.7177, "tiruchirappalli international airport tiruchirappalli tiruchirappally trichy"],
  ["TSA", "Taipei Songshan International Airport", "Taipei", "Taiwan", "Asia/Taipei", 25.0672, 121.5528],
  ["TSF", "Treviso Airport", "Treviso", "Italy", "Europe/Rome", 45.6484, 12.1944, "treviso airport treviso tv"],
  ["TSN", "Tianjin Binhai International Airport", "Tianjin", "China", "Asia/Shanghai", 39.1244, 117.3460],
  ["TSR", "Timișoara Traian Vuia International Airport", "Timişoara", "Romania", "Europe/Bucharest", 45.8099, 21.3379, "timișoara traian vuia international airport timişoara timisoara traian vuia international airport timisoara"],
  ["TTU", "Sania Ramel Airport", "Tétouan", "Morocco", "Africa/Casablanca", 35.5943, -5.3200, "sania ramel airport tétouan sania ramel airport tetouan"],
  ["TUC", "Teniente Benjamín Matienzo International Airport", "San Miguel de Tucumán", "Argentina", "America/Argentina/Tucuman", -26.8374, -65.1042, "teniente benjamín matienzo international airport san miguel de tucumán teniente benjamin matienzo international airport san miguel de tucuman"],
  ["TUK", "Turbat International Airport", "Turbat", "Pakistan", "Asia/Karachi", 25.9848, 63.0289],
  ["TUL", "Tulsa International Airport", "Tulsa", "United States", "America/Chicago", 36.1971, -95.8862],
  ["TUN", "Tunis Carthage International Airport", "Tunis", "Tunisia", "Africa/Tunis", 36.8510, 10.2272],
  ["TUS", "Tucson International Airport", "Tucson", "United States", "America/Phoenix", 32.1150, -110.9381],
  ["TUU", "Prince Sultan bin Abdulaziz International Airport", "Tabuk", "Saudi Arabia", "Asia/Riyadh", 28.3711, 36.6249],
  ["TXN", "Huangshan Tunxi International Airport", "Huangshan", "China", "Asia/Shanghai", 29.7333, 118.2560],
  ["TYN", "Taiyuan Wusu International Airport", "Taiyuan", "China", "Asia/Shanghai", 37.7469, 112.6280],
  ["TYS", "McGhee Tyson Airport", "Knoxville/Maryville", "United States", "America/New_York", 35.8110, -83.9940],
  ["TZL", "Tuzla International Airport", "Dubrave Gornje", "Bosnia and Herzegovina", "Europe/Sarajevo", 44.4599, 18.7236],
  ["UBN", "Ulaanbaatar Chinggis Khaan International Airport", "Ulaanbaatar", "Mongolia", "Asia/Ulaanbaatar", 47.6469, 106.8198, "ulaanbaatar chinggis khaan international airport ulaanbaatar sergelen"],
  ["UDR", "Maharana Pratap Airport", "Udaipur", "India", "Asia/Kolkata", 24.6177, 73.8961],
  ["UET", "Quetta International Airport", "Quetta", "Pakistan", "Asia/Karachi", 30.2514, 66.9378],
  ["UFA", "Ufa International Airport", "Ufa", "Russia", "Asia/Yekaterinburg", 54.5575, 55.8744],
  ["UGC", "Urgench International Airport", "Urgench", "Uzbekistan", "Asia/Samarkand", 41.5827, 60.6434],
  ["UIO", "Mariscal Sucre International Airport", "Quito", "Ecuador", "America/Guayaquil", -0.1254, -78.3543],
  ["UKB", "Kobe Airport", "Kobe", "Japan", "Asia/Tokyo", 34.6328, 135.2240],
  ["UKE", "Utkela Airport", "Bhawanipatna", "India", "Asia/Kolkata", 20.0978, 83.1833],
  ["UKK", "Oskemen International Airport", "Ust-Kamenogorsk", "Kazakhstan", "Asia/Almaty", 50.0350, 82.4961],
  ["ULH", "Al-Ula International Airport", "Al-Ula", "Saudi Arabia", "Asia/Riyadh", 26.4836, 38.1170],
  ["UME", "Umeå Airport", "Umeå", "Sweden", "Europe/Stockholm", 63.7918, 20.2828, "umeå airport umeå umea airport umea"],
  ["UPG", "Sultan Hasanuddin International Airport", "Makassar", "Indonesia", "Asia/Makassar", -5.0755, 119.5537],
  ["URA", "Manshuk Mametova International Airport", "Uralsk", "Kazakhstan", "Asia/Oral", 51.1520, 51.5437],
  ["URC", "Ürümqi Tianshan International Airport", "Ürümqi", "China", "Asia/Shanghai", 43.9136, 87.4794, "ürümqi tianshan international airport ürümqi urumqi tianshan international airport urumqi"],
  ["USM", "Samui International Airport", "Na Thon", "Thailand", "Asia/Bangkok", 9.5478, 100.0620, "samui international airport na thon ko island"],
  ["UTH", "Udon Thani International Airport", "Udon Thani", "Thailand", "Asia/Bangkok", 17.3862, 102.7886],
  ["UTP", "U-Tapao–Rayong–Pattaya International Airport", "Rayong", "Thailand", "Asia/Bangkok", 12.6799, 101.0050],
  ["UUD", "Baikal International Airport", "Ulan Ude", "Russia", "Asia/Irkutsk", 51.8086, 107.4397],
  ["UUS", "Yuzhno-Sakhalinsk International Airport", "Yuzhno-Sakhalinsk", "Russia", "Asia/Sakhalin", 46.8855, 142.7175],
  ["UVF", "Hewanorra International Airport", "Vieux Fort", "Saint Lucia", "America/St_Lucia", 13.7332, -60.9526],
  ["UYU", "Joya Andina International Airport", "Quijarro", "Bolivia", "America/La_Paz", -20.4413, -66.8576],
  ["VAA", "Vaasa Airport", "Vaasa", "Finland", "Europe/Helsinki", 63.0502, 21.7625],
  ["VAR", "Varna Airport", "Varna", "Bulgaria", "Europe/Sofia", 43.2321, 27.8251],
  ["VAV", "Vava'u International Airport", "Vava'u Island", "Tonga", "Pacific/Tongatapu", -18.5853, -173.9620],
  ["VBY", "Visby Airport", "Visby", "Sweden", "Europe/Stockholm", 57.6628, 18.3462],
  ["VCA", "Can Tho International Airport", "Can Tho", "Vietnam", "Asia/Ho_Chi_Minh", 10.0834, 105.7094],
  ["VCE", "Venice Marco Polo Airport", "Venezia", "Italy", "Europe/Rome", 45.5053, 12.3519, "venice marco polo airport venezia ve"],
  ["VCP", "Viracopos International Airport", "Campinas", "Brazil", "America/Sao_Paulo", -23.0074, -47.1345, "viracopos international airport campinas sao paulo"],
  ["VER", "General Heriberto Jara International Airport", "Veracruz", "Mexico", "America/Mexico_City", 19.1396, -96.1886],
  ["VFA", "Victoria Falls International Airport", "Victoria Falls", "Zimbabwe", "Africa/Harare", -18.0974, 25.8369],
  ["VGA", "Vijayawada International Airport", "Vijayawada", "India", "Asia/Kolkata", 16.5300, 80.8049, "vijayawada international airport vijayawada vidzhayavada"],
  ["VIE", "Vienna International Airport", "Vienna", "Austria", "Europe/Vienna", 48.1103, 16.5697],
  ["VIL", "Dakhla Airport", "Dakhla", "Western Sahara (disputed territory)", "Africa/El_Aaiun", 23.7183, -15.9320],
  ["VIX", "Eurico de Aguiar Salles International Airport", "Vitória", "Brazil", "America/Sao_Paulo", -20.2580, -40.2850, "eurico de aguiar salles international airport vitória eurico de aguiar salles international airport vitoria"],
  ["VKO", "Vnukovo International Airport", "Moscow", "Russia", "Europe/Moscow", 55.5915, 37.2615],
  ["VLC", "Valencia Airport", "Valencia", "Spain", "Europe/Madrid", 39.4892, -0.4810],
  ["VLI", "Bauerfield International Airport", "Port Vila", "Vanuatu", "Pacific/Efate", -17.6993, 168.3200],
  ["VLN", "Arturo Michelena International Airport", "Valencia", "Venezuela", "America/Caracas", 10.1497, -67.9284],
  ["VNO", "Vilnius International Airport", "Vilnius", "Lithuania", "Europe/Vilnius", 54.6341, 25.2858],
  ["VNS", "Lal Bahadur Shastri International Airport", "Varanasi", "India", "Asia/Kolkata", 25.4522, 82.8625, "lal bahadur shastri international airport varanasi benares"],
  ["VOG", "Volgograd International Airport", "Volgograd", "Russia", "Europe/Volgograd", 48.7813, 44.3392],
  ["VRA", "Juan Gualberto Gomez International Airport", "Matanzas", "Cuba", "America/Havana", 23.0344, -81.4353],
  ["VRN", "Verona Villafranca Valerio Catullo Airport", "Caselle", "Italy", "Europe/Rome", 45.3950, 10.8873, "verona villafranca valerio catullo airport caselle vr"],
  ["VSA", "Carlos Rovirosa Pérez International Airport", "Villahermosa", "Mexico", "America/Mexico_City", 17.9943, -92.8182, "carlos rovirosa pérez international airport villahermosa carlos rovirosa perez international airport villahermosa"],
  ["VST", "Stockholm Västerås Airport", "Vasteras", "Sweden", "Europe/Stockholm", 59.5894, 16.6336, "stockholm västerås airport vasteras stockholm vasteras airport vasteras"],
  ["VSV", "Shravasti Airport", "Shravasti", "India", "Asia/Kolkata", 27.4997, 82.0329],
  ["VTE", "Wattay International Airport", "Vientiane", "Laos", "Asia/Vientiane", 17.9851, 102.5667],
  ["VTZ", "Alluri Sitarama Raju International Airport (Vizag)", "Visakhapatnam", "India", "Asia/Kolkata", 17.9715, 83.5036],
  ["VVI", "Viru Viru International Airport", "Santa Cruz", "Bolivia", "America/La_Paz", -17.6448, -63.1354],
  ["VVO", "Vladivostok International Airport", "Artyom", "Russia", "Asia/Vladivostok", 43.3963, 132.1482],
  ["VXE", "Cesaria Evora International Airport", "São Pedro", "Cape Verde", "Atlantic/Cape_Verde", 16.8334, -25.0553, "cesaria evora international airport são pedro cesaria evora international airport sao pedro"],
  ["WAW", "Warsaw Chopin Airport", "Warsaw", "Poland", "Europe/Warsaw", 52.1657, 20.9671],
  ["WDH", "Hosea Kutako International Airport", "Windhoek", "Namibia", "Africa/Windhoek", -22.4799, 17.4709],
  ["WLG", "Wellington International Airport", "Wellington", "New Zealand", "Pacific/Auckland", -41.3268, 174.8069],
  ["WLS", "Hihifo Airport", "Wallis Island", "Wallis and Futuna", "Pacific/Wallis", -13.2394, -176.1986],
  ["WMI", "Warsaw Modlin Airport", "Warsaw", "Poland", "Europe/Warsaw", 52.4511, 20.6518, "warsaw modlin airport warsaw nowy dwór mazowiecki warsaw modlin airport warsaw nowy dwor mazowiecki"],
  ["WNZ", "Wenzhou Longwan International Airport", "Wenzhou", "China", "Asia/Shanghai", 27.9106, 120.8535],
  ["WRO", "Copernicus Wrocław Airport", "Wrocław", "Poland", "Europe/Warsaw", 51.1037, 16.8821],
  ["WTB", "Toowoomba Wellcamp Airport", "Toowoomba", "Australia", "Australia/Brisbane", -27.5583, 151.7933],
  ["WUH", "Wuhan Tianhe International Airport", "Wuhan", "China", "Asia/Shanghai", 30.7748, 114.2137, "wuhan tianhe international airport wuhan huangpi"],
  ["WUX", "Sunan Shuofang International Airport", "Wuxi", "China", "Asia/Shanghai", 31.4970, 120.4304],
  ["WVB", "Walvis Bay International Airport", "Walvis Bay", "Namibia", "Africa/Windhoek", -22.9793, 14.6471, "walvis bay international airport walvis bay rooikop"],
  ["XBJ", "Birjand International Airport", "Birjand", "Iran", "Asia/Tehran", 32.8965, 59.2813],
  ["XIY", "Xi'an Xianyang International Airport", "Xi'an", "China", "Asia/Shanghai", 34.4422, 108.7624],
  ["XMN", "Xiamen Gaoqi International Airport", "Xiamen", "China", "Asia/Shanghai", 24.5439, 118.1275],
  ["XNN", "Xining Caojiabao International Airport", "Haidong", "China", "Asia/Shanghai", 36.5277, 102.0402, "xining caojiabao international airport haidong huzhu tu autonomous county"],
  ["XPL", "Palmerola International Airport", "Palmerola", "Honduras", "America/Tegucigalpa", 14.3824, -87.6212],
  ["YAP", "Yap International Airport", "Yap Island", "Micronesia", "Pacific/Chuuk", 9.4989, 138.0830],
  ["YCU", "Yuncheng Yanhu International Airport", "Yuncheng", "China", "Asia/Shanghai", 35.1178, 111.0340],
  ["YEG", "Edmonton International Airport", "Edmonton", "Canada", "America/Edmonton", 53.3097, -113.5800],
  ["YHZ", "Halifax / Stanfield International Airport", "Halifax", "Canada", "America/Halifax", 44.8808, -63.5086],
  ["YIA", "Yogyakarta International Airport", "Yogyakarta", "Indonesia", "Asia/Jakarta", -7.9053, 110.0573],
  ["YIW", "Yiwu Airport", "Yiwu/Jinhua", "China", "Asia/Shanghai", 29.3421, 120.0312],
  ["YKS", "Platon Oyunsky Yakutsk International Airport", "Yakutsk", "Russia", "Asia/Yakutsk", 62.0933, 129.7710],
  ["YLW", "Kelowna International Airport", "Kelowna", "Canada", "America/Vancouver", 49.9561, -119.3780],
  ["YNB", "Prince Abdulmohsen Bin Abdulaziz International Airport", "Yanbu", "Saudi Arabia", "Asia/Riyadh", 24.1442, 38.0634],
  ["YNT", "Yantai Penglai International Airport", "Yantai", "China", "Asia/Shanghai", 37.6597, 120.9781],
  ["YNY", "Yangyang International Airport", "Gonghang-ro", "South Korea", "Asia/Seoul", 38.0605, 128.6698],
  ["YNZ", "Yancheng Nanyang International Airport", "Yancheng", "China", "Asia/Shanghai", 33.4283, 120.2054, "yancheng nanyang international airport yancheng tinghu"],
  ["YOW", "Ottawa Macdonald-Cartier International Airport", "Ottawa", "Canada", "America/Toronto", 45.3225, -75.6692],
  ["YQB", "Quebec Jean Lesage International Airport", "Quebec", "Canada", "America/Toronto", 46.7911, -71.3933],
  ["YUL", "Montreal / Pierre Elliott Trudeau International Airport", "Montréal", "Canada", "America/Toronto", 45.4678, -73.7423, "montreal pierre elliott trudeau international airport montréal montreal pierre elliott trudeau international airport montreal"],
  ["YVR", "Vancouver International Airport", "Vancouver", "Canada", "America/Vancouver", 49.1939, -123.1840],
  ["YWG", "Winnipeg / James Armstrong Richardson International Airport", "Winnipeg", "Canada", "America/Winnipeg", 49.9100, -97.2399],
  ["YXE", "Saskatoon John G. Diefenbaker International Airport", "Saskatoon", "Canada", "America/Regina", 52.1707, -106.7008],
  ["YYC", "Calgary International Airport", "Calgary", "Canada", "America/Edmonton", 51.1188, -114.0099],
  ["YYJ", "Victoria International Airport", "Victoria", "Canada", "America/Vancouver", 48.6472, -123.4278],
  ["YYT", "St. John's International Airport", "St. John's", "Canada", "America/St_Johns", 47.6186, -52.7519],
  ["YYZ", "Toronto Pearson International Airport", "Toronto", "Canada", "America/Toronto", 43.6759, -79.6294],
  ["ZAD", "Zadar Airport", "Zadar", "Croatia", "Europe/Zagreb", 44.0970, 15.3536],
  ["ZAG", "Zagreb Franjo Tuđman International Airport", "Velika Gorica", "Croatia", "Europe/Zagreb", 45.7429, 16.0688],
  ["ZAH", "Zahedan International Airport", "Zahedan", "Iran", "Asia/Tehran", 29.4757, 60.9062],
  ["ZAM", "Zamboanga International Airport", "Zamboanga", "Philippines", "Asia/Manila", 6.9224, 122.0600],
  ["ZAZ", "Zaragoza Airport", "Zaragoza", "Spain", "Europe/Madrid", 41.6662, -1.0415],
  ["ZCO", "La Araucanía International Airport", "Temuco", "Chile", "America/Santiago", -38.9259, -72.6515, "la araucanía international airport temuco la araucania international airport temuco"],
  ["ZHA", "Zhanjiang Wuchuan International Airport", "Zhanjiang", "China", "Asia/Shanghai", 21.4817, 110.5903],
  ["ZIA", "Zhukovsky International Airport", "Moscow", "Russia", "Europe/Moscow", 55.5533, 38.1500],
  ["ZIH", "Ixtapa-Zihuatanejo International Airport", "Ixtapa", "Mexico", "America/Mexico_City", 17.6018, -101.4606],
  ["ZNZ", "Abeid Amani Karume International Airport", "Zanzibar", "Tanzania", "Africa/Dar_es_Salaam", -6.2220, 39.2249],
  ["ZQN", "Queenstown Airport", "Queenstown", "New Zealand", "Pacific/Auckland", -45.0192, 168.7464],
  ["ZRH", "Zürich Airport", "Zurich", "Switzerland", "Europe/Zurich", 47.4581, 8.5481, "zürich airport zurich zurich airport zurich"],
  ["ZSA", "San Salvador International Airport", "San Salvador", "Bahamas", "America/Nassau", 24.0630, -74.5232],
  ["ZSE", "Saint-Pierre Pierrefonds Airport", "Saint-Pierre", "Réunion", "Indian/Reunion", -21.3194, 55.4225],
  ["ZUH", "Zhuhai Jinwan Airport", "Zhuhai", "China", "Asia/Shanghai", 22.0064, 113.3760],
  ["ZYL", "Osmany International Airport", "Sylhet", "Bangladesh", "Asia/Dhaka", 24.9640, 91.8647],
];

// What a city name means, PRIMARY FIRST.
//
// Two different jobs, and the second is easy to miss:
//
//   1. METRO AREAS, where one name covers several airports. Cannot be derived:
//      OurAirports files Malpensa under "Ferno", Linate under "Segrate",
//      Narita under "Narita", Dulles under "Dulles" and Sabiha Gokcen under
//      "Pendik", so grouping by municipality finds neither Milan nor Tokyo nor
//      Washington nor Istanbul. It also merges PDX (Portland, Oregon) with PWM
//      (Portland, Maine), which is why membership is listed rather than
//      inferred.
//
//   2. UNRELATED CITIES THAT SHARE A NAME, where the entry settles which one a
//      bare name means. Without it the tie-break falls through to the IATA
//      code alphabetically, which is arbitrary — that is how "Birmingham"
//      came to mean Alabama rather than the England one four times its size.
//      The alternatives are still offered; only the default changes.
//
// Keys are lowercase and unaccented. 38 entries.
const CITY_AIRPORTS: Record<string, string[]> = {
  "london": ["LHR", "LGW", "STN", "LTN"],
  "new york": ["JFK", "EWR", "LGA"],
  "nyc": ["JFK", "EWR", "LGA"],
  "new york city": ["JFK", "EWR", "LGA"],
  "tokyo": ["HND", "NRT"],
  "paris": ["CDG", "ORY", "BVA"],
  "milan": ["MXP", "LIN", "BGY"],
  "moscow": ["SVO", "DME", "VKO", "ZIA"],
  "sao paulo": ["GRU", "CGH", "VCP"],
  "são paulo": ["GRU", "CGH", "VCP"],
  "washington": ["IAD", "DCA", "BWI"],
  "washington dc": ["IAD", "DCA", "BWI"],
  "washington d c": ["IAD", "DCA", "BWI"],
  "chicago": ["ORD", "MDW"],
  "rome": ["FCO", "CIA"],
  "beijing": ["PEK", "PKX"],
  "shanghai": ["PVG", "SHA"],
  "seoul": ["ICN", "GMP"],
  "osaka": ["KIX", "ITM"],
  "bangkok": ["BKK", "DMK"],
  "jakarta": ["CGK", "HLP"],
  "tehran": ["IKA", "THR"],
  "istanbul": ["IST", "SAW"],
  "doha": ["DOH", "DIA"],
  "dubai": ["DXB", "DWC"],
  "amman": ["AMM", "ADJ"],
  "colombo": ["CMB", "RML"],
  "mexico city": ["MEX", "NLU"],
  "rio de janeiro": ["GIG", "SDU"],
  "rio": ["GIG", "SDU"],
  "buenos aires": ["EZE", "AEP"],
  "johannesburg": ["JNB", "HLA"],
  "houston": ["IAH", "HOU"],
  "stockholm": ["ARN", "NYO", "VST"],
  "oslo": ["OSL", "TRF"],
  "glasgow": ["GLA", "PIK"],
  "taipei": ["TPE", "TSA"],
  "kuala lumpur": ["KUL", "SZB"],
  "melbourne": ["MEL", "AVV"],
  "tenerife": ["TFS", "TFN"],
  "goa": ["GOI", "GOX"],
  "san francisco": ["SFO", "OAK", "SJC"],
  // Not a metro: two unrelated cities, one name. BHX carries about four times
  // BHM's traffic, and someone typing "Birmingham" into a flight search from
  // India means England. Alabama stays reachable, as the second option and by
  // its code.
  "birmingham": ["BHX", "BHM"],
  // Same again: Victoria BC against the Seychelles capital. YYJ carries about
  // five times SEZ's traffic, and the old default was the alphabet, not a
  // judgement.
  "victoria": ["YYJ", "SEZ"],
};

// Built on first use, not at import: an app that never searches by name pays
// nothing for this file beyond the array literal above.
let INDEX: Map<string, Airport> | null = null;
let HAYSTACK: { a: Airport; s: string }[] = [];

// Every exact city name in the dataset, plus every curated alias. Built with
// the index, because a set of 1,223 strings is the difference between a gate
// that can answer "is this a place?" and one that has to guess.
let PLACES: Set<string> | null = null;

// ── CITY_AIRPORTS, INVERTED ─────────────────────────────────────────────────
//
// CODE -> THE GROUP THAT CONTAINS IT. CITY_AIRPORTS is keyed on the METRO name,
// and the only way back into it was an airport's own `city` field — which agrees
// with the metro for JFK and LGA ("New York") and does not for EWR ("Newark").
// Fourteen of the eighty-seven curated codes are in that position: Newark,
// Luton, Beauvais, Bergamo, Oakland, San Jose, Campinas and seven more are all
// genuinely in their own town, so tapping one found no group and offered no
// alternatives while its siblings offered it.
//
// IATA IS THE ONLY KEY THAT IS RELIABLY REVERSIBLE. A city string is a name that
// may or may not match; a code is the identity the group was written in terms
// of. Inverting once at build time turns the failing direction into a lookup.
//
// THE DATA IS NOT TOUCHED. Newark is in Newark and the panel still says so; what
// was wrong was the grouping, not the row.
let GROUP_OF: Map<string, string[]> | null = null;

function build() {
  if (INDEX !== null) return;
  INDEX = new Map();
  PLACES = new Set(Object.keys(CITY_AIRPORTS));
  // FIRST KEY WINS, and it does not matter which. Several keys are aliases for
  // one group — "new york", "nyc" and "new york city" all list JFK, EWR, LGA —
  // and their contents are identical, so any of them is the same answer.
  GROUP_OF = new Map();
  for (const key of Object.keys(CITY_AIRPORTS)) {
    const codes = CITY_AIRPORTS[key];
    for (const code of codes) {
      if (!GROUP_OF.has(code)) GROUP_OF.set(code, codes);
    }
  }
  HAYSTACK = AIRPORT_ROWS.map(r => {
    const a: Airport = { iata: r[0], name: r[1], city: r[2], country: r[3], tz: r[4], lat: r[5], lon: r[6] };
    INDEX!.set(a.iata, a);
    // normalizeTerm, not toLowerCase: the generator strips punctuation when it
    // decides a row needs no `search` of its own, so the fallback has to strip it
    // too or "O'Hare" would be one word to the data and two to the device.
    const s = r[7] ?? normalizeTerm(`${a.name} ${a.city}`);
    PLACES!.add(normalizeTerm(a.city));
    return { a, s };
  });
}

// IS THIS SPAN A PLACE, exactly?
//
// An accessor rather than an export of CITY_AIRPORTS: handing out the map
// invites callers to reimplement matching against it, and every reimplementation
// is a way for two answers to the same question to drift apart. This is the only
// question the caller has.
//
// EXACT ONLY — an exact city name, a curated alias, or a real IATA code. It
// deliberately does NOT go through resolveAirportName, whose lowest tier matches
// any haystack that merely CONTAINS the term: that tier answers "time" with
// Nice, "land" with Gothenburg and "sfo" with Sydney, because Kingsford Smith
// contains those three letters. Useful for ranking a search the user has
// committed to; useless for deciding whether a sentence is about travel at all.
export function isKnownPlace(term: string): boolean {
  build();
  const q = normalizeTerm(term);
  if (q.length < MIN_TERM) return false;
  if (PLACES!.has(q)) return true;
  return q.length === 3 && INDEX!.has(q.toUpperCase());
}

// Lowercase, collapse whitespace, drop punctuation. The same normalisation is
// applied to the data at generation time, so the two cannot drift.
export function normalizeTerm(term: string): string {
  return String(term ?? '')
    .toLowerCase()
    .replace(/[^0-9a-z\u00c0-\u024f ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// The airport for an IATA code, or null when the code is not in the set. This is
// what makes a fake code rejectable on the device: a three-letter string that
// misses here is known to be wrong before anything has been spent on it.
export function airportByCode(code: string): Airport | null {
  build();
  const k = String(code ?? '').trim().toUpperCase();
  return INDEX!.get(k) ?? null;
}

// EVERY AIRPORT, FOR DRAWING RATHER THAN FOR ANSWERING. Every other export here
// takes a term and returns a verdict; this one hands over the rows, because the
// map plots the whole set and culls it against a camera. That is the one caller
// that wants the data rather than a decision about it.
//
// BUILT ONCE AND HANDED OUT AS-IS. The array is cached rather than rebuilt,
// because a caller that reads it on every camera change must not pay 1,223
// allocations to do so. Callers must not mutate it.
let ALL: Airport[] | null = null;
export function allAirports(): Airport[] {
  build();
  if (ALL === null) ALL = HAYSTACK.map(h => h.a);
  return ALL;
}

// THE AIRPORTS OF A CITY, AS ROWS.
//
// STILL NOT AN EXPORT OF CITY_AIRPORTS, for the reason given at isKnownPlace:
// the map holds CODES, and a caller holding codes has to reimplement the lookup
// from code to row — which is the second implementation the note there is about.
// This returns the thing a caller actually wants.
//
// THE CURATED LIST WINS WHERE THERE IS ONE, because it carries an order a person
// would expect: "new york" is JFK, EWR, LGA rather than whatever order the rows
// happen to sit in. Everything else falls back to every row whose city matches,
// which is the common case and is usually exactly one.
// IT TAKES THE ROW, NOT THE NAME. The city string was the wrong key — it is a
// name that may or may not match the metro the group is filed under, and for
// fourteen airports it does not. The row carries the IATA code, which is what
// CITY_AIRPORTS is actually written in terms of. Every caller already has the
// row; none of them had only the name.
//
// THREE WAYS IN, TRIED IN ORDER, AND EVERY ONE OF THEM RETURNS A LIST THAT
// CONTAINS THE AIRPORT ITSELF. That last property is not incidental: the panel
// marks the current airport green within this list, so a list that omitted it
// would render a set of alternatives with nothing selected.
//
//   1  the reverse index, by code      EWR -> JFK, EWR, LGA
//   2  the curated list, by city name  covers a row whose city IS a metro key
//      but which is not itself curated — and only when that list includes it,
//      or the airport would be missing from its own panel
//   3  every row with the same city    the common case: one airport, one city
export function cityAirports(airport: Airport): Airport[] {
  build();
  const rows = (codes: string[]): Airport[] => {
    const out: Airport[] = [];
    for (const code of codes) {
      const a = INDEX!.get(code);
      if (a !== undefined) out.push(a);
    }
    return out;
  };

  const group = GROUP_OF!.get(airport.iata);
  if (group !== undefined) return rows(group);

  const q = normalizeTerm(airport.city);
  const curated = CITY_AIRPORTS[q];
  if (curated !== undefined && curated.includes(airport.iata)) return rows(curated);

  return HAYSTACK.filter(h => normalizeTerm(h.a.city) === q).map(h => h.a);
}

// Whole-word test against a normalised haystack. Both sides are already
// lowercase and single-spaced, so this is four string compares rather than a
// regular expression built fresh for every one of the 1,212 rows.
function hasWord(s: string, q: string): boolean {
  return s === q || s.startsWith(`${q} `) || s.endsWith(` ${q}`) || s.includes(` ${q} `);
}

// MATCH QUALITY, in the order it is preferred. Lower is better.
//
//   0  the term IS the city                  "mumbai" -> Mumbai
//   1  a whole word of the haystack          "bali" -> Denpasar, "bombay" -> Mumbai
//   2  the city starts with the term         "mumb" -> Mumbai
//   3  the airport name starts with it       "heathrow" -> Heathrow
//   4  a word of the haystack starts with it "bengal" -> Bengaluru
//   5  the haystack merely contains it       "alur" -> Bengaluru
//
// A whole word outranks a prefix deliberately: "bali" is an exact alias of
// Denpasar and only a prefix of Balice, and the exact one is what was meant.
// Substring matching is last so a short term can never outrank a real name.
function rankOf(a: Airport, s: string, q: string): number {
  const city = a.city.toLowerCase();
  if (city === q) return 0;
  if (hasWord(s, q)) return 1;
  if (city.startsWith(q)) return 2;
  if (a.name.toLowerCase().startsWith(q)) return 3;
  if (s.startsWith(q) || s.includes(` ${q}`)) return 4;
  if (s.includes(q)) return 5;
  return -1;
}

// Terms under three characters match nothing: two letters would pull in a large
// part of the file and mean nothing to a reader.
const MIN_TERM = 3;

function scoreAll(q: string): { a: Airport; rank: number }[] {
  const out: { a: Airport; rank: number }[] = [];
  for (const { a, s } of HAYSTACK) {
    const rank = rankOf(a, s, q);
    if (rank >= 0) out.push({ a, rank });
  }
  // Ties break on the shorter city name, then the code, so a result never
  // depends on the order the source file happened to be in.
  out.sort((x, y) =>
    x.rank - y.rank
    || x.a.city.length - y.a.city.length
    || x.a.iata.localeCompare(y.a.iata));
  return out;
}

// Airports matching a city or airport name, best first, or [] for no match.
export function findAirports(term: string, limit = 8): Airport[] {
  const q = normalizeTerm(term);
  if (q.length < MIN_TERM) return [];
  build();
  const curated = CITY_AIRPORTS[q];
  if (curated) {
    const hit = curated.map(c => INDEX!.get(c)).filter((x): x is Airport => !!x);
    if (hit.length > 0) return hit.slice(0, limit);
  }
  return scoreAll(q).slice(0, limit).map(v => v.a);
}

// One resolved airport, plus the alternatives the term could equally have meant.
//
// `options` holds every candidate of the SAME quality as the winner, so it is
// length 1 for an unambiguous name and longer only when the term genuinely does
// not choose between airports. That is the signal the caller uses to decide
// whether to offer a picker: "Mumbai" returns BOM alone even though Navi Mumbai
// also matches, because Navi Mumbai is a worse match, not an alternative
// reading. "London" and "Portland" both return several.
// `rank` is the match quality that scoreAll already computed and used to throw
// away: 0 the term IS the city, 1 a whole word, up through 5 a bare substring.
// Returned rather than discarded so a caller can tell a confident hit from a
// coincidence — which is what decides whether a model's reading is trusted
// enough to spend units on.
export function resolveAirportName(term: string): { airport: Airport; options: Airport[]; rank: number } | null {
  const q = normalizeTerm(term);
  if (q.length < MIN_TERM) return null;
  build();
  const curated = CITY_AIRPORTS[q];
  if (curated) {
    const hit = curated.map(c => INDEX!.get(c)).filter((x): x is Airport => !!x);
    // A curated entry is the best kind of match there is: someone wrote it down.
    if (hit.length > 0) return { airport: hit[0], options: hit.slice(0, 8), rank: 0 };
  }
  const scored = scoreAll(q);
  if (scored.length === 0) return null;
  const best = scored[0].rank;
  return {
    airport: scored[0].a,
    options: scored.filter(v => v.rank === best).slice(0, 8).map(v => v.a),
    rank: best,
  };
}

// THE AIRPORT NEAREST A POSITION.
//
// A DATASET QUESTION, SO IT LIVES WITH THE DATASET. The panel already measures
// the distance from the user to ONE airport; this asks the opposite question of
// all 1,223, and putting it in the screen would be a second copy of the
// great-circle formula in a file that has no business owning one.
//
// FULL HAVERSINE RATHER THAN A CHEAPER RANKING. An equirectangular
// approximation would order these correctly almost everywhere and misorder them
// near the poles and across the date line, which are precisely the cases nobody
// would ever check. 1,223 iterations of this run once per position, behind a
// memo, and cost nothing worth trading a caveat for.
//
// NULL ONLY IF THE DATASET IS EMPTY, which it cannot be -- it is baked in. The
// signature says null anyway so the caller cannot forget that "nearest" is
// undefined over an empty set.
export function nearestAirport(lon: number, lat: number): Airport | null {
  const R = 6371, D = Math.PI / 180;
  let best: Airport | null = null;
  let bestKm = Infinity;
  for (const a of allAirports()) {
    const dLat = (a.lat - lat) * D;
    const dLon = (a.lon - lon) * D;
    const h = Math.sin(dLat / 2) ** 2
      + Math.cos(lat * D) * Math.cos(a.lat * D) * Math.sin(dLon / 2) ** 2;
    const km = 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    if (km < bestKm) { bestKm = km; best = a; }
  }
  return best;
}
