# Saltmarsh Coastal Sensor Network: Field Report 2024 to 2026

_Written by Claude for the Curie search benchmark. Every place, person, organisation and number in it is made up._

## 1 Summary

The Halden Coastal Trust runs fourteen measuring stations along the Saltmarsh coast, from Kestrel Head in the north
to Low Rock in the south. Each station reports tide height, water temperature, salinity and wind every ten minutes.
Before this project the network was unreliable: in 2023 the stations were online for 81.4 percent of the year on
average, and the worst of them for barely half of it. Gaps tended to come in winter storms, exactly when the
measurements matter most to the harbour and to the people living behind the dunes.

Between January 2024 and February 2026 the trust rebuilt the power systems, replaced most of the sensors, changed
how the stations talk to the office and moved the data to new storage. The work was paid for mostly by a grant from
the Marine Resilience Fund. This report describes what was changed, what it cost, what went wrong on the way, and
how the network performed in 2025, its first full year after the upgrade.

The short version: uptime across the network rose to 96.8 percent in 2025, the share of usable ten-minute readings
reached 98.9 percent, and the network gave the harbour master four hours of warning before the storm surge of
November 2025. Some problems remain, mainly ice at the two northern stations and the future of one gateway site.

## 2 Background: the network before the upgrade

### 2.1 Stations and their sites

The first six stations were installed in 2014 by volunteers from the Saltmarsh sailing club, who wanted reliable
tide readings for the estuary bar. The trust took them over in 2017 and added eight more by 2020, using whatever
grants were available at the time. As a result the stations were built in at least four different ways, with three
kinds of data logger and two kinds of mast.

Eleven stations stand on the mainland, on piers, sea walls or the end of a groyne. Three stand on small islands in
the estuary: Tern Island, Mallow Skerry and Low Rock. The island stations can only be reached by boat, and only for
a few hours around low water, which shapes almost every decision about their maintenance. A full list of stations,
with their codes and the year each was built, is in Appendix A.

### 2.2 Known problems

Three problems accounted for most of the lost data before 2024.

The first was power. Every station ran on a lead-acid battery charged by a 160 watt solar panel. In summer this was
plenty. From November to February, with short days and solar panels caked in salt spray, the batteries ran flat
within a week of cloudy weather, and the station went silent until the sun came back. Lead-acid batteries also lose
capacity quickly when they are drained deeply, so by 2023 most of them held less than half of their rated charge.

The second was the radio link. Stations sent their readings over a licence-free radio network to three gateways in
the towns of Harrow Quay, Sorrel Bay and Ebbing. Messages from the stations furthest from a gateway were lost often,
and nobody could tell from the office whether a station was silent because of the radio or because it had died.

The third was the sensors themselves. Tide height was measured with pressure transducers mounted under water, which
drifted with temperature and silted up. The salinity sensors fouled quickly, so their readings drifted within weeks
of every cleaning.

The worst station was Gull Point, code S-07, on an exposed sea wall facing the prevailing wind. In 2023 it was
online for only 52 percent of the year, and almost all of its missing data fell between October and March.

## 3 Goals and constraints

The trust set itself four goals for the project: network-wide uptime of at least 95 percent in the first full year
after the upgrade; no station below 90 percent; readings that could be used for storm warnings without a person
checking them first; and open publication of the data.

The constraints were just as clear. The grant covered two years. No station could be moved, because the value of
the record depends on measuring at the same place year after year. Work on the island stations had to fit into the
low-water windows, and the trust has two field technicians, not a team. Finally, the board asked that nothing be
built that the trust could not maintain alone once the grant ended, which ruled out several proposals from
suppliers who wanted to sell a service contract along with the hardware.

## 4 Hardware changes

### 4.1 Power

The lead-acid batteries were replaced at every station with lithium iron phosphate packs of 2.4 kilowatt hours.
They cost about three times as much but can be drained almost completely without damage and weigh a third as much,
which matters when a pack has to be carried across rocks to an island station. The 160 watt solar panels were
replaced with 300 watt panels mounted at a steeper angle, so that rain washes off more of the salt and the panel
catches more of the low winter sun.

Even with the larger panels the energy budget in December is tight. A station uses about 0.9 kilowatt hours a day
with the new radios and heated wind sensor bearings, and on the shortest days a 300 watt panel in Saltmarsh weather
delivers less than that. The batteries bridge the gap for about four days without sun.

To close the gap the trust trialled small wind turbines at two of the windiest stations, Kestrel Head (S-03) and Gull
Point (S-07). Both turbines were rated at 400 watts and mounted on the existing masts. The turbine at Kestrel Head
was taken down after five months because a holiday campsite two hundred metres away complained about the noise it
made at night, and the trust decided the goodwill of its neighbours was worth more than the extra power.

The turbine at Gull Point had no neighbours to disturb. It stayed in place and covered about 35 percent of the
station's energy use from November to February, which is the main reason Gull Point stayed online through its first
full winter since it was built.

### 4.2 Sensors

The pressure transducers used for tide height were replaced with radar level sensors mounted above the water on a
bracket. A radar sensor never touches the water, so it does not silt up and does not drift with water temperature.
Its readings were checked against a staff gauge at every station for two weeks after installation, and agreed to
within one centimetre at all but one site, where a floating pontoon got in the way of the beam and the sensor had
to be moved half a metre along the pier.

Water temperature sensors were kept, since they had proved reliable. The salinity sensors were replaced with a newer
conductivity model, but the new sensors fouled just as badly as the old ones. Within a few weeks of being cleaned,
barnacles and weed grew over the measuring cell and the readings crept downwards. Cleaning every three weeks was not
possible at the island stations.

The fix came from the fishing cooperative, whose members protect their own equipment the same way: each salinity
sensor now sits inside a copper anti-fouling sleeve. Larvae do not settle on copper, and the sleeve stretched the
interval between cleanings from three weeks to nine. The sleeves cost twelve euros each and are replaced once a year.

Wind sensors were replaced with ultrasonic anemometers, which have no moving parts to seize up in salt air. The
older cup anemometers at the three most exposed stations had needed new bearings every winter.

### 4.3 Enclosures and corrosion

All electronics were moved into new enclosures rated IP67, closed with marine-grade 316 stainless steel fasteners.
The enclosures were fixed to the masts with aluminium brackets supplied by the enclosure maker, which turned out to
be a mistake. Within eight months the brackets at four stations had corroded badly where they touched the steel
fasteners, a textbook case of two different metals meeting in salt water. At Tern Island one bracket cracked and the
enclosure was found hanging by its cable after a storm.

The aluminium brackets were replaced at every station with brackets made of glass-fibre reinforced plastic, which
cannot corrode. The replacement took one visit per station and cost about 6,800 euros in parts, paid from the
contingency budget.

### 4.4 Loggers and firmware

The three kinds of data logger left over from the early years were replaced with a single model, so that a
technician carries one set of spare parts and one cable kit. Each logger reads its sensors once a minute, averages
the readings over ten minutes and hands the result to the radio. It keeps the last thirty days of readings in its
own memory, which is what saved the record when the office server failed in 2024.

All loggers run the same firmware, built by Priya Nandakumar from the supplier's open source release with three
changes of her own: a watchdog that restarts the logger if a sensor stops answering, a record of the battery voltage
in every message, and the switch to the satellite modem described in section 5.2. Firmware updates are sent over the
radio at night, one station at a time, and a station that fails to start the new version falls back to the old one
on its own. Eleven updates were sent during the project; one was withdrawn after it made the radar sensors at three
stations report in feet instead of metres for an afternoon.

Every logger's settings, such as the sensor heights above chart datum and the calibration of each salinity sensor,
are kept in a single file in the trust's version control, so that a replaced logger can be set up the same way in
minutes. Before the project these settings existed only on the loggers themselves and in one technician's notebook.

### 4.5 Suppliers and buying

Most of the hardware was bought through two public tenders, one for the power systems and one for the sensors and
loggers, as the grant required for purchases above 40,000 euros. Seven suppliers answered the power tender and four
the sensor tender. The trust chose on price, delivery time and how easily its own technicians could repair the
equipment, and turned down the two cheapest sensor offers because their radar units could only be serviced by
sending them abroad.

Delivery took longer than planned. The lithium packs arrived eleven weeks late because of a shortage of cells, which
pushed the power work at the island stations from the spring low tides into the autumn ones. The trust kept the
old lead-acid batteries running at those stations through the summer and swapped them during the September spring
tides, with a hired boat and both technicians.

## 5 Communications

### 5.1 Radio links

The old radio network was replaced with LoRaWAN on 868 megahertz, using the same three gateway sites in Harrow Quay,
Sorrel Bay and Ebbing. LoRaWAN uses little power and reaches far, but in the first months after the switch the
stations south of Harrow Quay still lost many messages: 6.2 percent of all messages from those stations never
arrived.

The cause was the gateway antenna at Harrow Quay, which sat on a harbour building at a height of four metres and was
shadowed by the sea wall. In June 2024 the antenna was moved to a new mast on the same building, raising it from
four metres to nine. Message loss from the southern stations fell to 1.1 percent, which is about the level of the
rest of the network.

The Sorrel Bay gateway sits in the tower of St Brigid's church, on a lease from the parish. The tower is an
excellent site, but the lease runs out in 2027 and the parish has said it may not renew it, because the diocese
plans to sell the building.

### 5.2 Satellite fallback

Every station now also carries a small satellite modem that can send short messages from anywhere. It is used only
as a fallback: if a station has not reached a gateway for thirty minutes, it starts sending its readings by
satellite until the radio link is back. Each satellite message costs 0.18 euros, so the trust capped satellite
spending at 250 euros a month across the whole network. Once the cap is reached, stations keep their readings in
memory and send them when the radio link returns.

In 2025 the fallback was used on 41 days, mostly during storms that knocked out power to a gateway. The cap was
reached only once, in November.

### 5.3 Watching the network itself

Before the project nobody noticed a silent station until someone needed its readings. Now the office receives, with
every message, the station's battery voltage, its solar charging current, the temperature inside the enclosure and
the strength of the radio signal. A dashboard shows all fourteen stations on one screen, and two alerts go to the
technicians' phones: one when a station has been silent for an hour, and one when a battery drops below 30 percent.

The alerts were tuned over the first summer. At first the silence alert fired whenever a single message went
missing, several times a day, and the technicians started to ignore it. After it was changed to wait for six missed
messages in a row it fired about twice a week, almost always for a real reason. The battery alert gave the first
warning of the power shortfall at Gull Point in the winter of 2024, a week before the station would have gone dark,
and the technicians replaced its panel with a larger spare during the next low tide.

The gateways report on themselves as well. Each sends a short status message every five minutes, and if one goes
quiet the dashboard marks every station that depends on it, so that a gateway failure is not mistaken for fourteen
separate station failures.

## 6 Data pipeline

### 6.1 Ingestion

Readings arrive at the office every ten minutes from each station, either from the gateways or from the satellite
service. A small ingestion service, written by the trust's data engineer Priya Nandakumar, receives every message,
checks that it is well formed, and writes it to the database with the time it was measured and the time it
arrived. Messages that arrive late, after a radio outage, are slotted into place by their measurement time.

### 6.2 Quality control

Every reading passes three automatic checks before it is published. The range check rejects values that are
physically impossible for the site, such as a water temperature above 30 degrees. The flatline check flags a sensor
that has sent identical readings for six hours, which usually means it has frozen or lost its connection. The spike
check flags a tide reading that changes by more than 0.4 metres in ten minutes.

In the first months the spike check was far too eager. Waves running along the sea walls made the radar readings
jump, and the check raised about 340 false alarms a month, each of which someone had to look at. In April 2025 the
check was changed to compare the median of the last three readings instead of single readings, and to ignore jumps
that reverse within twenty minutes. False alarms fell to about 22 a month, and none of the real events of 2025 was
missed.

Flagged readings are not deleted. They are kept with their flag, published with it, and can be cleared by hand.

### 6.3 Storage and retention

Until March 2025 the data lived on a server in the trust's office. Its disks failed twice in 2024, and the second
time two weeks of readings could only be recovered from the stations' own memory. In March 2025 the data moved to
object storage at a cloud provider in the same country, with a copy kept in a second region.

Raw ten-minute readings are kept for ten years. Hourly averages, which are what most users download, are kept
indefinitely. The original messages as they arrived from the stations are kept for one year, so that the ingestion
can be repeated if a bug is found.

### 6.4 Publishing and access

Readings are published in three ways. The trust's website shows the latest values and a week of history for each
station, in charts that work on a phone. A download page offers hourly averages for any period as a spreadsheet
file. And a small web service answers machine requests for the same data, which is how the harbour office and two
sailing apps take their tide readings.

The web service has no accounts. Each caller may make 600 requests an hour, which is far more than any current user
needs, and the limit exists only to protect the trust's storage bill from a runaway script. In 2025 the service
answered about 2.1 million requests, two thirds of them from the sailing apps.

Every published value carries the station code, the time it was measured, and its quality flag. A user who wants
only clean data can ask for readings without flags; the default returns everything, flags included, because the
trust found that people who study storms often want the extreme readings the checks are most likely to flag.

## 7 Field operations

### 7.1 Maintenance visits

Each station is visited once a quarter for cleaning, a check against the staff gauge and a look at the mast and
fasteners. The field supervisor, Tomasz Brekke, plans the visits around the tide tables, since the three island
stations can only be reached by boat within about two hours of low water. A visit to an island station takes most
of a day, including the crossing.

Unplanned visits fell from 63 in 2023 to 19 in 2025, mostly because batteries and anemometers stopped failing.

### 7.2 Safety incidents

There was one safety incident during the project. In March 2025 a technician slipped on algae-covered rock while
carrying a battery pack to the Low Rock station (S-11) and sprained a wrist. Since then nobody works in the tidal
zone alone: a two-person rule applies to every visit below the high-water line, and the technicians wear studded
boots on rock. The trust also bought a lighter trolley for carrying battery packs across the shingle at Mallow
Skerry.

### 7.3 Training and volunteers

The two technicians, Tomasz Brekke and Aino Lindqvist, did most of the installation work themselves, with help from
the supplier's engineer for the first station of each kind. Both completed a sea survival course and a first aid
course paid for by the project, and Aino Lindqvist qualified to skipper the trust's own small boat in 2025, which
cut the number of boat charters by half.

Volunteers still play a part. Members of the sailing club read the staff gauges at the six oldest stations every
fortnight and send the readings by text message, which gives an independent check on the radar sensors between the
quarterly visits. Twelve volunteers took part in 2025, and three of them have read the same gauge every fortnight
since 2014.

### 7.4 Permits and landowners

Every station stands on land or water that belongs to someone else: the harbour authority, two town councils, a
nature reserve, the parish of Sorrel Bay and four private owners. Each site has a written agreement, and nine of
them had to be renewed or rewritten for the new equipment, mostly because the masts at those sites became taller.

The three island stations lie inside the Saltmarsh Estuary nature reserve, where work is not allowed during the
nesting season from April to July. The reserve's warden agreed a plan with the trust in which emergency repairs may
still be made in that season, by one boat landing and with no more than two people ashore, after a call to the
warden. That permission was used once, in May 2025, when a gull broke the radar bracket at Tern Island.

## 8 Costs and funding

The project cost 508,500 euros in total. The Marine Resilience Fund paid 412,000 euros under grant MRF-2291, and the
trust paid the remaining 96,500 euros from its own reserves and two local donations.

Hardware took the largest share at 261,000 euros, including batteries, solar panels, sensors, enclosures and the
satellite modems. Communications, meaning the new gateways, the antenna mast at Harrow Quay and two years of
satellite messages, cost 48,300 euros. Staff time for the two technicians and the data engineer came to 151,200
euros. A contingency of 48,000 euros was set aside, of which 31,700 euros was used, mostly for the replacement
brackets and an extra boat charter after a gateway failed in a storm.

The project manager, Dr Ines Varga, reported to the trust board every quarter. Spending stayed within the budget
in every quarter but one, when the bracket replacements were brought forward after the Tern Island failure.

## 9 Results

### 9.1 Uptime

In 2025 the stations were online for 96.8 percent of the year on average, against 81.4 percent in 2023. Gull Point,
the weakest station before the upgrade, reached 91.3 percent. The lowest station in 2025 was Kestrel Head at 90.2
percent, which lost ten days in February when ice formed on its radar sensor (see section 10). Every station met the
goal of at least 90 percent.

### 9.2 Data quality

The share of ten-minute readings that arrived and passed all checks rose to 98.9 percent in 2025. Most of the
missing readings fell in two storms in which a gateway lost power and the satellite cap had already been reached.
The radar tide readings agree with the staff gauges to within one centimetre at every site, and the salinity
readings stay within the sensor's specification for about nine weeks after each cleaning.

### 9.3 Community use

The data is published on the trust's website as hourly averages and as live ten-minute readings. The Saltmarsh
fishing cooperative uses the tide and wind readings to decide when boats can cross the estuary bar. Breda Primary
School built a year of lessons around the water temperature records of the nearest station, and its pupils now
read the station themselves every Monday.

On 11 November 2025 the network gave its most important result so far. Tide readings at the three southern stations
rose well above the forecast during the evening, and the harbour master of Harrow Quay received the automatic
storm surge warning four hours before high water. The flood gates in the harbour were closed in time, and the
quayside shops were not flooded, unlike during a similar surge in 2021.

## 10 Problems that remain

Ice is the main remaining problem at the two northern stations, Kestrel Head and Heron Flats. On cold nights spray
freezes on the radar sensor and on the anemometer, and the readings stop until the ice melts. Heated enclosures
were considered and rejected because heating would use more power than the stations can collect in winter. The
trust will try hydrophobic coatings and a small shield above each radar sensor in the winter of 2026.

Two of the new salinity sensors drift: their readings fall by about 0.3 salinity units per quarter, even when the
sensors are clean. From autumn 2026 the technicians will calibrate them every month against standard seawater
during their visits, and the supplier has agreed to replace both sensors if the drift continues.

The gateway in the St Brigid's church tower may have to leave the building when its lease ends in 2027. Without it,
four stations around Sorrel Bay would rely on the satellite fallback, which the monthly cap could not cover.

## 11 Decisions and next steps

On 18 February 2026 the trust board made three decisions. First, the network becomes a permanent part of the
trust's work, funded from its own budget after the grant ends, at an estimated 54,000 euros a year. Second, all data
is published under the Creative Commons Attribution licence, CC BY 4.0, so that anyone can reuse it with credit to
the trust. Third, four more stations will be added by the end of 2027, filling the gap between Ebbing and Low Rock.

To secure the Sorrel Bay link, a dedicated gateway mast will be built on land owned by the trust before the church
lease ends, by mid-2027 at the latest. The board also asked for a review of the satellite cap once the new stations
are online.

## 12 Lessons learned

Some of what the trust learned would apply to any small organisation running equipment by the sea.

Buy for repair, not for price. The stations that gave the least trouble in 2025 were the ones whose parts the
technicians could change on site with hand tools. The one sensor that had to go back to its maker for a repair was
out of service for seven weeks.

Test every material against salt water before buying it in quantity. The aluminium brackets came with the
enclosures and nobody questioned them, and replacing them cost a visit to every station. A single bracket left on a
test mast for a winter would have shown the problem.

Measure the network, not only the sea. The battery and radio readings added to every message cost almost nothing,
and they turned most failures from surprises into planned visits.

Write things down where others can find them. Settings that lived in one person's notebook, and site agreements that
lived in a drawer, were the slowest part of every repair before the project. Both now sit in the trust's shared
files, and new staff can find them without asking.

Talk to the neighbours early. The wind turbine at Kestrel Head is the only part of the project that was undone, and
a conversation with the campsite before it was installed would have saved the cost of putting it up and taking it
down again.

Ask the people who already work on the water. The copper sleeves came from the fishing cooperative, the idea for the
volunteer gauge readings from the sailing club, and the best site for the new Sorrel Bay mast from a retired
harbour pilot who remembered where the radio reception had always been good.

## Appendix A: Station list

The fourteen stations, from north to south, with their codes and the year each was first built: Kestrel Head
(S-03, 2014), Heron Flats (S-01, 2015), Harrow Quay North (S-02, 2014), Harrow Quay Pier (S-04, 2014), Tern Island
(S-05, 2016), Gull Point (S-07, 2014), Sorrel Bay Wall (S-06, 2015), Sorrel Bay Groyne (S-08, 2017), Mallow Skerry
(S-09, 2018), Ebbing Harbour (S-10, 2014), Ebbing Sands (S-12, 2019), Brine Marsh (S-13, 2019), Seal Bank (S-14,
2020) and Low Rock (S-11, 2014).

## Appendix B: Station notes

Kestrel Head (S-03) stands on the end of a breakwater at the northern edge of the network. It is the windiest site,
and the most troubled by ice: spray freezes on the mast on about twenty nights a year. Its radar sensor looks down
onto a patch of open water kept clear by the breakwater, which makes its tide readings among the steadiest in the
network when the sensor is not iced over.

Heron Flats (S-01) measures the upper estuary, where the water is brackish and the salinity readings swing widely
with every tide. It is the station the school pupils read, because it stands next to a public footpath and its
enclosure has a window showing the logger's display.

Harrow Quay North (S-02) and Harrow Quay Pier (S-04) both serve the harbour. The harbour master asked for two
stations so that a failure of one would never leave the harbour without readings, and in 2025 they were never
silent at the same time.

Tern Island (S-05) is the most remote station, a forty-minute boat trip from Harrow Quay. Its mast was rebuilt in
2024 after the bracket failure described in section 4.3, and it is now the only station with two independent
batteries, so that a failed pack does not cost a boat trip at short notice.

Gull Point (S-07) stands on an old sea wall facing the open sea. Before the upgrade it was the least reliable
station; after the new panel, the lithium pack and the wind turbine it ran through the winter of 2025 with only
short gaps, mostly while ice cleared from its anemometer.

Sorrel Bay Wall (S-06) and Sorrel Bay Groyne (S-08) depend on the gateway in the church tower, and so do Mallow
Skerry (S-09) and Brine Marsh (S-13). These four are the stations at risk if the gateway has to leave the tower
before the new mast is built.

Mallow Skerry (S-09) is reached across a shingle bank at low water rather than by boat, but the walk takes forty
minutes each way carrying equipment, which is why the lighter trolley mentioned in section 7.2 was bought.

Ebbing Harbour (S-10) and Ebbing Sands (S-12) measure the southern bay. Ebbing Sands stands on a beach that changes
shape with every winter storm, and its mast has been reset twice since 2019 after the sand under it washed away.

Brine Marsh (S-13) and Seal Bank (S-14) are the newest stations, built in 2019 and 2020. Seal Bank is closed to
visits for six weeks each summer while the seals pup on the bank beside it, so its maintenance visit falls in late
August.

Low Rock (S-11) is the southernmost station and one of the original six. It stands on a rock ledge covered at high
water, which makes it the hardest station to work on safely, and it is where the safety incident of 2025 happened.

## Appendix C: Glossary

Gateway: a radio receiver on a building or mast that passes station messages on to the office over the internet.
Staff gauge: a measuring board fixed at the water's edge, read by eye, used to check the electronic tide readings.
Flatline: a run of identical readings, usually a sign that a sensor has stopped measuring. Anti-fouling: any way of
stopping marine life from settling on equipment in the water. Uptime: the share of time a station is sending
readings that arrive at the office.
