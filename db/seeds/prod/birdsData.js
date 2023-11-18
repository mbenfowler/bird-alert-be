const birdsData = [
  {"comName":"Ross's Goose","sciName":"Anser rossii","speciesCode":"rosgoo","category":"species","order":"Anseriformes","familyCode":"anatid1","familyComName":"Ducks, Geese, and Waterfowl","familySciName":"Anatidae","birdImg":"https://images.unsplash.com/photo-1634506264722-0d6e457efc16?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=539045","taxonOrder":"260"},
  {"comName":"Canada Goose","sciName":"Branta canadensis","speciesCode":"cangoo","category":"species","order":"Anseriformes","familyCode":"anatid1","familyComName":"Ducks, Geese, and Waterfowl","familySciName":"Anatidae","birdImg":"https://images.unsplash.com/photo-1513209395699-7a1e7f745942?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=218972","taxonOrder":"324"},
  {"comName":"Mute Swan","sciName":"Cygnus olor","speciesCode":"mutswa","category":"species","order":"Anseriformes","familyCode":"anatid1","familyComName":"Ducks, Geese, and Waterfowl","familySciName":"Anatidae","birdImg":"https://images.unsplash.com/photo-1582730463790-3c3864de6cbf?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=19614307","taxonOrder":"358"},
  {"comName":"Lesser Scaup","sciName":"Aythya affinis","speciesCode":"lessca","category":"species","order":"Anseriformes","familyCode":"anatid1","familyComName":"Ducks, Geese, and Waterfowl","familySciName":"Anatidae","birdImg":"https://images.unsplash.com/photo-1632700601246-75a49a9ce4bc?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=268686","taxonOrder":"661"},
  {"comName":"Surf Scoter","sciName":"Melanitta perspicillata","speciesCode":"sursco","category":"species","order":"Anseriformes","familyCode":"anatid1","familyComName":"Ducks, Geese, and Waterfowl","familySciName":"Anatidae","birdImg":"https://images.unsplash.com/photo-1645799142571-5e075c44dbbf?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=337822","taxonOrder":"688"},
  {"comName":"Long-tailed Duck","sciName":"Clangula hyemalis","speciesCode":"lotduc","category":"species","order":"Anseriformes","familyCode":"anatid1","familyComName":"Ducks, Geese, and Waterfowl","familySciName":"Anatidae","birdImg":"https://images.unsplash.com/photo-1643032683525-3bc8cfe066bb?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=252740","taxonOrder":"700"},
  {"comName":"Bufflehead","sciName":"Bucephala albeola","speciesCode":"buffle","category":"species","order":"Anseriformes","familyCode":"anatid1","familyComName":"Ducks, Geese, and Waterfowl","familySciName":"Anatidae","birdImg":"https://images.unsplash.com/photo-1648786345750-13d22ffcc774?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=264547","taxonOrder":"701"},
  {"comName":"Wild Turkey","sciName":"Meleagris gallopavo","speciesCode":"wiltur","category":"species","order":"Galliformes","familyCode":"phasia1","familyComName":"Pheasants, Grouse, and Allies","familySciName":"Phasianidae","birdImg":"https://images.unsplash.com/photo-1549274205-480f304ad040?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=297071","taxonOrder":"1222"},
  {"comName":"Ring-necked Pheasant","sciName":"Phasianus colchicus","speciesCode":"rinphe1","category":"species","order":"Galliformes","familyCode":"phasia1","familyComName":"Pheasants, Grouse, and Allies","familySciName":"Phasianidae","birdImg":"https://images.unsplash.com/photo-1622909967994-49e65035ffeb?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=196347","taxonOrder":"1420"},
  {"comName":"Pied-billed Grebe","sciName":"Podilymbus podiceps","speciesCode":"pibgre","category":"species","order":"Podicipediformes","familyCode":"podici1","familyComName":"Grebes","familySciName":"Podicipedidae","birdImg":"https://images.unsplash.com/photo-1642081117189-9fda3be13009?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=213172","taxonOrder":"1831"},
  {"comName":"Horned Grebe","sciName":"Podiceps auritus","speciesCode":"horgre","category":"species","order":"Podicipediformes","familyCode":"podici1","familyComName":"Grebes","familySciName":"Podicipedidae","birdImg":"https://images.unsplash.com/photo-1641579696391-b6688c50b34d?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=203814","taxonOrder":"1842"},
  {"comName":"Sabine's Gull","sciName":"Xema sabini","speciesCode":"sabgul","category":"species","order":"Charadriiformes","familyCode":"larida1","familyComName":"Gulls, Terns, and Skimmers","familySciName":"Laridae","birdImg":"https://images.unsplash.com/photo-1550909237-8912a1440073?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=384225","taxonOrder":"6415"},
  {"comName":"Bonaparte's Gull","sciName":"Chroicocephalus philadelphia","speciesCode":"bongul","category":"species","order":"Charadriiformes","familyCode":"larida1","familyComName":"Gulls, Terns, and Skimmers","familySciName":"Laridae","birdImg":"https://images.unsplash.com/photo-1656513430343-0b5e6daa2640?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=335162","taxonOrder":"6422"},
  {"comName":"Laughing Gull","sciName":"Leucophaeus atricilla","speciesCode":"laugul","category":"species","order":"Charadriiformes","familyCode":"larida1","familyComName":"Gulls, Terns, and Skimmers","familySciName":"Laridae","birdImg":"https://images.unsplash.com/photo-1628001463052-b4a2bb18b78c?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=265672","taxonOrder":"6448"},
  {"comName":"Ring-billed Gull","sciName":"Larus delawarensis","speciesCode":"ribgul","category":"species","order":"Charadriiformes","familyCode":"larida1","familyComName":"Gulls, Terns, and Skimmers","familySciName":"Laridae","birdImg":"https://images.unsplash.com/photo-1645663700036-cf839b55e306?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=335554","taxonOrder":"6479"},
  {"comName":"Herring Gull","sciName":"Larus argentatus","speciesCode":"hergul","category":"species","order":"Charadriiformes","familyCode":"larida1","familyComName":"Gulls, Terns, and Skimmers","familySciName":"Laridae","birdImg":"https://images.unsplash.com/photo-1556653631-2cd10fb4c440?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=27565629","taxonOrder":"6496"},
  {"comName":"Great Black-backed Gull","sciName":"Larus marinus","speciesCode":"gbbgul","category":"species","order":"Charadriiformes","familyCode":"larida1","familyComName":"Gulls, Terns, and Skimmers","familySciName":"Laridae","birdImg":"https://images.unsplash.com/photo-1656513321623-78d54f36dde8?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=299648","taxonOrder":"6516"},
  {"comName":"Lesser Black-backed Gull","sciName":"Larus fuscus","speciesCode":"lbbgul","category":"species","order":"Charadriiformes","familyCode":"larida1","familyComName":"Gulls, Terns, and Skimmers","familySciName":"Laridae","birdImg":"https://images.unsplash.com/photo-1627004107746-fb41afdd809d?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=299657","taxonOrder":"6526"},
  {"comName":"Brown Booby","sciName":"Sula leucogaster","speciesCode":"brnboo","category":"species","order":"Suliformes","familyCode":"sulida1","familyComName":"Boobies and Gannets","familySciName":"Sulidae","birdImg":"https://images.unsplash.com/photo-1643093894148-1e57a0ce5da3?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=1033471","taxonOrder":"7172"},
  {"comName":"Anhinga","sciName":"Anhinga anhinga","speciesCode":"anhing","category":"species","order":"Suliformes","familyCode":"anhing3","familyComName":"Anhingas","familySciName":"Anhingidae","birdImg":"https://images.unsplash.com/photo-1623798275980-c6dbd4c4d9f0?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=183962","taxonOrder":"7195"},
  {"comName":"Double-crested Cormorant","sciName":"Nannopterum auritum","speciesCode":"doccor","category":"species","order":"Suliformes","familyCode":"phalac1","familyComName":"Cormorants and Shags","familySciName":"Phalacrocoracidae","birdImg":"https://images.unsplash.com/photo-1596435069748-4a3237f4ddd8?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=215227","taxonOrder":"7253"},
  {"comName":"American White Pelican","sciName":"Pelecanus erythrorhynchos","speciesCode":"amwpel","category":"species","order":"Pelecaniformes","familyCode":"peleca1","familyComName":"Pelicans","familySciName":"Pelecanidae","birdImg":"https://images.unsplash.com/photo-1627779297670-347bb212810e?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=214290","taxonOrder":"7288"},
  {"comName":"Tundra Swan","sciName":"Cygnus columbianus","speciesCode":"tunswa","category":"species","order":"Anseriformes","familyCode":"anatid1","familyComName":"Ducks, Geese, and Waterfowl","familySciName":"Anatidae","birdImg":"https://images.unsplash.com/photo-1626405687101-0d7ec3acdc10?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=232255","taxonOrder":"365"},
  {"comName":"Muscovy Duck","sciName":"Cairina moschata","speciesCode":"musduc","category":"species","order":"Anseriformes","familyCode":"anatid1","familyComName":"Ducks, Geese, and Waterfowl","familySciName":"Anatidae","birdImg":"https://images.unsplash.com/photo-1604338834026-0aec6ac202bf?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=364625","taxonOrder":"423"},
  {"comName":"Wood Duck","sciName":"Aix sponsa","speciesCode":"wooduc","category":"species","order":"Anseriformes","familyCode":"anatid1","familyComName":"Ducks, Geese, and Waterfowl","familySciName":"Anatidae","birdImg":"https://images.unsplash.com/photo-1517465096483-7631c1c48b75?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=252112","taxonOrder":"433"},
  {"comName":"Blue-winged Teal","sciName":"Spatula discors","speciesCode":"buwtea","category":"species","order":"Anseriformes","familyCode":"anatid1","familyComName":"Ducks, Geese, and Waterfowl","familySciName":"Anatidae","birdImg":"https://images.unsplash.com/photo-1662692837581-4df7428e1c5b?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=251176","taxonOrder":"460"},
  {"comName":"Northern Shoveler","sciName":"Spatula clypeata","speciesCode":"norsho","category":"species","order":"Anseriformes","familyCode":"anatid1","familyComName":"Ducks, Geese, and Waterfowl","familySciName":"Anatidae","birdImg":"https://images.unsplash.com/photo-1648997567747-f6a95bf3ce2a?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=226344","taxonOrder":"474"},
  {"comName":"Rock Pigeon","sciName":"Columba livia","speciesCode":"rocpig","category":"species","order":"Columbiformes","familyCode":"columb2","familyComName":"Pigeons and Doves","familySciName":"Columbidae","birdImg":"https://images.unsplash.com/photo-1617946546355-6ee938390350?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=197191","taxonOrder":"1874"},
  {"comName":"Eurasian Collared-Dove","sciName":"Streptopelia decaocto","speciesCode":"eucdov","category":"species","order":"Columbiformes","familyCode":"columb2","familyComName":"Pigeons and Doves","familySciName":"Columbidae","birdImg":"https://images.unsplash.com/photo-1641504380274-299a1cdd860a?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=323988","taxonOrder":"2051"},
  {"comName":"Mourning Dove","sciName":"Zenaida macroura","speciesCode":"moudov","category":"species","order":"Columbiformes","familyCode":"columb2","familyComName":"Pigeons and Doves","familySciName":"Columbidae","birdImg":"https://images.unsplash.com/photo-1623597898920-effd89b88ce1?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=393255","taxonOrder":"2427"},
  {"comName":"Ruby-throated Hummingbird","sciName":"Archilochus colubris","speciesCode":"rthhum","category":"species","order":"Caprimulgiformes","familyCode":"trochi1","familyComName":"Hummingbirds","familySciName":"Trochilidae","birdImg":"https://images.unsplash.com/photo-1607030396118-721d84ae0ff1?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=325846","taxonOrder":"4776"},
  {"comName":"Rufous Hummingbird","sciName":"Selasphorus rufus","speciesCode":"rufhum","category":"species","order":"Caprimulgiformes","familyCode":"trochi1","familyComName":"Hummingbirds","familySciName":"Trochilidae","birdImg":"https://images.unsplash.com/photo-1660878295970-64e226012a66?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=236936","taxonOrder":"4798"},
  {"comName":"American Coot","sciName":"Fulica americana","speciesCode":"y00475","category":"species","order":"Gruiformes","familyCode":"rallid1","familyComName":"Rails, Gallinules, and Coots","familySciName":"Rallidae","birdImg":"https://images.unsplash.com/photo-1639252663898-11b064569b14?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=308728","taxonOrder":"5474"},
  {"comName":"Limpkin","sciName":"Aramus guarauna","speciesCode":"limpki","category":"species","order":"Gruiformes","familyCode":"aramid1","familyComName":"Limpkin","familySciName":"Aramidae","birdImg":"https://images.unsplash.com/photo-1623798274833-3d0fd933eb6a?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=262216","taxonOrder":"5642"},
  {"comName":"Spotted Sandpiper","sciName":"Actitis macularius","speciesCode":"sposan","category":"species","order":"Charadriiformes","familyCode":"scolop2","familyComName":"Sandpipers and Allies","familySciName":"Scolopacidae","birdImg":"https://images.unsplash.com/flagged/photo-1553368189-6c76d70a44d2?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=315151","taxonOrder":"6091"},
  {"comName":"Solitary Sandpiper","sciName":"Tringa solitaria","speciesCode":"solsan","category":"species","order":"Charadriiformes","familyCode":"scolop2","familyComName":"Sandpipers and Allies","familySciName":"Scolopacidae","birdImg":"https://images.unsplash.com/photo-1609527847383-e24254fdd2aa?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=290205","taxonOrder":"6094"},
  {"comName":"Lesser Yellowlegs","sciName":"Tringa flavipes","speciesCode":"lesyel","category":"species","order":"Charadriiformes","familyCode":"scolop2","familyComName":"Sandpipers and Allies","familySciName":"Scolopacidae","birdImg":"https://images.unsplash.com/photo-1656451935256-7805e1fb5c1e?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=302455","taxonOrder":"6109"},
  {"comName":"Willet","sciName":"Tringa semipalmata","speciesCode":"willet1","category":"species","order":"Charadriiformes","familyCode":"scolop2","familyComName":"Sandpipers and Allies","familySciName":"Scolopacidae","birdImg":"https://images.unsplash.com/photo-1623796565725-ba532999b211?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=302249","taxonOrder":"6111"},
  {"comName":"Black Tern","sciName":"Chlidonias niger","speciesCode":"blkter","category":"species","order":"Charadriiformes","familyCode":"larida1","familyComName":"Gulls, Terns, and Skimmers","familySciName":"Laridae","birdImg":"https://images.unsplash.com/photo-1634236211352-bb2dc13b5884?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=315407","taxonOrder":"6664"},
  {"comName":"Forster's Tern","sciName":"Sterna forsteri","speciesCode":"forter","category":"species","order":"Charadriiformes","familyCode":"larida1","familyComName":"Gulls, Terns, and Skimmers","familySciName":"Laridae","birdImg":"https://images.unsplash.com/photo-1597779609275-c1352e9c616a?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=390362","taxonOrder":"6670"},
  {"comName":"Common Tern","sciName":"Sterna hirundo","speciesCode":"comter","category":"species","order":"Charadriiformes","familyCode":"larida1","familyComName":"Gulls, Terns, and Skimmers","familySciName":"Laridae","birdImg":"https://images.unsplash.com/photo-1597243690107-8a7616f65024?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=239842","taxonOrder":"6686"},
  {"comName":"Common Loon","sciName":"Gavia immer","speciesCode":"comloo","category":"species","order":"Gaviiformes","familyCode":"gaviid1","familyComName":"Loons","familySciName":"Gaviidae","birdImg":"https://images.unsplash.com/photo-1660765181897-a992a8204b5a?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=183527","taxonOrder":"6774"},
  {"comName":"Wood Stork","sciName":"Mycteria americana","speciesCode":"woosto","category":"species","order":"Ciconiiformes","familyCode":"ciconi2","familyComName":"Storks","familySciName":"Ciconiidae","birdImg":"https://images.unsplash.com/photo-1662433452450-53a95263ed31?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=579947","taxonOrder":"7138"},
  {"comName":"Magnificent Frigatebird","sciName":"Fregata magnificens","speciesCode":"magfri","category":"species","order":"Suliformes","familyCode":"fregat1","familyComName":"Frigatebirds","familySciName":"Fregatidae","birdImg":"https://images.unsplash.com/photo-1658807036136-217ddf7579dd?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=23987676","taxonOrder":"7147"},
  {"comName":"American Wigeon","sciName":"Mareca americana","speciesCode":"amewig","category":"species","order":"Anseriformes","familyCode":"anatid1","familyComName":"Ducks, Geese, and Waterfowl","familySciName":"Anatidae","birdImg":"https://images.unsplash.com/photo-1634502141156-8de3e97ad93f?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=226965","taxonOrder":"487"},
  {"comName":"Mallard","sciName":"Anas platyrhynchos","speciesCode":"mallar3","category":"species","order":"Anseriformes","familyCode":"anatid1","familyComName":"Ducks, Geese, and Waterfowl","familySciName":"Anatidae","birdImg":"https://images.unsplash.com/photo-1579444798661-ce60beaa0413?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=230456","taxonOrder":"515"},
  {"comName":"American Black Duck","sciName":"Anas rubripes","speciesCode":"ambduc","category":"species","order":"Anseriformes","familyCode":"anatid1","familyComName":"Ducks, Geese, and Waterfowl","familySciName":"Anatidae","birdImg":"https://images.unsplash.com/photo-1659664007103-e0ad4701973e?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=250759","taxonOrder":"537"},
  {"comName":"Yellow-billed Cuckoo","sciName":"Coccyzus americanus","speciesCode":"yebcuc","category":"species","order":"Cuculiformes","familyCode":"cuculi1","familyComName":"Cuckoos","familySciName":"Cuculidae","birdImg":"https://images.unsplash.com/photo-1603206988834-89810cbea1d0?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=347775","taxonOrder":"3230"},
  {"comName":"Common Nighthawk","sciName":"Chordeiles minor","speciesCode":"comnig","category":"species","order":"Caprimulgiformes","familyCode":"caprim2","familyComName":"Nightjars and Allies","familySciName":"Caprimulgidae","birdImg":"https://images.unsplash.com/photo-1662686670235-1b1fa1540010?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=357331","taxonOrder":"3508"},
  {"comName":"Chimney Swift","sciName":"Chaetura pelagica","speciesCode":"chiswi","category":"species","order":"Caprimulgiformes","familyCode":"apodid1","familyComName":"Swifts","familySciName":"Apodidae","birdImg":"https://images.unsplash.com/photo-1652794773884-bd659391c605?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=349317","taxonOrder":"3874"},
  {"comName":"Brown Pelican","sciName":"Pelecanus occidentalis","speciesCode":"brnpel","category":"species","order":"Pelecaniformes","familyCode":"peleca1","familyComName":"Pelicans","familySciName":"Pelecanidae","birdImg":"https://images.unsplash.com/photo-1517516745392-000dfd0d26c1?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=214296","taxonOrder":"7289"},
  {"comName":"Canvasback","sciName":"Aythya valisineria","speciesCode":"canvas","category":"species","order":"Anseriformes","familyCode":"anatid1","familyComName":"Ducks, Geese, and Waterfowl","familySciName":"Anatidae","birdImg":"https://images.unsplash.com/photo-1604040058326-a3b482c6fe27?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=249880","taxonOrder":"627"},
  {"comName":"Ring-necked Duck","sciName":"Aythya collaris","speciesCode":"rinduc","category":"species","order":"Anseriformes","familyCode":"anatid1","familyComName":"Ducks, Geese, and Waterfowl","familySciName":"Anatidae","birdImg":"https://images.unsplash.com/photo-1662905048828-b922c97a2332?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=250184","taxonOrder":"634"},
  {"comName":"Greater Scaup","sciName":"Aythya marila","speciesCode":"gresca","category":"species","order":"Anseriformes","familyCode":"anatid1","familyComName":"Ducks, Geese, and Waterfowl","familySciName":"Anatidae","birdImg":"https://images.unsplash.com/photo-1630497946593-2d38c0fd65a7?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=268647","taxonOrder":"655"},
  {"comName":"Sandhill Crane","sciName":"Antigone canadensis","speciesCode":"sancra","category":"species","order":"Gruiformes","familyCode":"gruida1","familyComName":"Cranes","familySciName":"Gruidae","birdImg":"https://images.unsplash.com/photo-1623804807248-89cd46371563?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=362346","taxonOrder":"5671"},
  {"comName":"American Avocet","sciName":"Recurvirostra americana","speciesCode":"ameavo","category":"species","order":"Charadriiformes","familyCode":"recurv1","familyComName":"Stilts and Avocets","familySciName":"Recurvirostridae","birdImg":"https://images.unsplash.com/photo-1634506264292-956289c9d06f?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=274283","taxonOrder":"5751"},
  {"comName":"Killdeer","sciName":"Charadrius vociferus","speciesCode":"killde","category":"species","order":"Charadriiformes","familyCode":"charad1","familyComName":"Plovers and Lapwings","familySciName":"Charadriidae","birdImg":"https://images.unsplash.com/photo-1506370990336-4e9a83bc4232?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=276101","taxonOrder":"5798"},
  {"comName":"Semipalmated Plover","sciName":"Charadrius semipalmatus","speciesCode":"semplo","category":"species","order":"Charadriiformes","familyCode":"charad1","familyComName":"Plovers and Lapwings","familySciName":"Charadriidae","birdImg":"https://images.unsplash.com/photo-1658227431556-cebc0f037ded?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=276813","taxonOrder":"5805"},
  {"comName":"Little Blue Heron","sciName":"Egretta caerulea","speciesCode":"libher","category":"species","order":"Pelecaniformes","familyCode":"ardeid1","familyComName":"Herons, Egrets, and Bitterns","familySciName":"Ardeidae","birdImg":"https://images.unsplash.com/photo-1607967601692-5a18b04fea44?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=589897","taxonOrder":"7401"},
  {"comName":"Snowy Egret","sciName":"Egretta thula","speciesCode":"snoegr","category":"species","order":"Pelecaniformes","familyCode":"ardeid1","familyComName":"Herons, Egrets, and Bitterns","familySciName":"Ardeidae","birdImg":"https://images.unsplash.com/photo-1597259980768-dd2c76cc18ae?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=273564","taxonOrder":"7416"},
  {"comName":"Green Heron","sciName":"Butorides virescens","speciesCode":"grnher","category":"species","order":"Pelecaniformes","familyCode":"ardeid1","familyComName":"Herons, Egrets, and Bitterns","familySciName":"Ardeidae","birdImg":"https://images.unsplash.com/photo-1566351426161-721b925b26ae?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=272861","taxonOrder":"7469"},
  {"comName":"Great Egret","sciName":"Ardea alba","speciesCode":"greegr","category":"species","order":"Pelecaniformes","familyCode":"ardeid1","familyComName":"Herons, Egrets, and Bitterns","familySciName":"Ardeidae","birdImg":"https://images.unsplash.com/photo-1530512645697-20fe002976b9?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=238430","taxonOrder":"7491"},
  {"comName":"Common Goldeneye","sciName":"Bucephala clangula","speciesCode":"comgol","category":"species","order":"Anseriformes","familyCode":"anatid1","familyComName":"Ducks, Geese, and Waterfowl","familySciName":"Anatidae","birdImg":"https://images.unsplash.com/photo-1610472904591-20dbfbd8f2d1?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=263664","taxonOrder":"702"},
  {"comName":"Hooded Merganser","sciName":"Lophodytes cucullatus","speciesCode":"hoomer","category":"species","order":"Anseriformes","familyCode":"anatid1","familyComName":"Ducks, Geese, and Waterfowl","familySciName":"Anatidae","birdImg":"https://images.unsplash.com/photo-1662179712146-e52345dec602?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=256256","taxonOrder":"712"},
  {"comName":"Red-breasted Merganser","sciName":"Mergus serrator","speciesCode":"rebmer","category":"species","order":"Anseriformes","familyCode":"anatid1","familyComName":"Ducks, Geese, and Waterfowl","familySciName":"Anatidae","birdImg":"https://images.unsplash.com/photo-1648560308786-82aefa021098?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=258825","taxonOrder":"728"},
  {"comName":"Ruddy Duck","sciName":"Oxyura jamaicensis","speciesCode":"rudduc","category":"species","order":"Anseriformes","familyCode":"anatid1","familyComName":"Ducks, Geese, and Waterfowl","familySciName":"Anatidae","birdImg":"https://images.unsplash.com/photo-1631526821452-cb0d2396f5ce?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=263896","taxonOrder":"736"},
  {"comName":"Greater Yellowlegs","sciName":"Tringa melanoleuca","speciesCode":"greyel","category":"species","order":"Charadriiformes","familyCode":"scolop2","familyComName":"Sandpipers and Allies","familySciName":"Scolopacidae","birdImg":"https://images.unsplash.com/photo-1620097756340-24336216cd37?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=302440","taxonOrder":"6118"},
  {"comName":"Dunlin","sciName":"Calidris alpina","speciesCode":"dunlin","category":"species","order":"Charadriiformes","familyCode":"scolop2","familyComName":"Sandpipers and Allies","familySciName":"Scolopacidae","birdImg":"https://images.unsplash.com/photo-1641665312217-24c9b5f685f2?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=287662","taxonOrder":"6156"},
  {"comName":"Least Sandpiper","sciName":"Calidris minutilla","speciesCode":"leasan","category":"species","order":"Charadriiformes","familyCode":"scolop2","familyComName":"Sandpipers and Allies","familySciName":"Scolopacidae","birdImg":"https://images.unsplash.com/photo-1645563146565-02b724df9038?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=304271","taxonOrder":"6187"},
  {"comName":"Semipalmated Sandpiper","sciName":"Calidris pusilla","speciesCode":"semsan","category":"species","order":"Charadriiformes","familyCode":"scolop2","familyComName":"Sandpipers and Allies","familySciName":"Scolopacidae","birdImg":"https://images.unsplash.com/photo-1662120527714-0a3ec81f2cca?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=277471","taxonOrder":"6193"},
  {"comName":"Snow Goose","sciName":"Anser caerulescens","speciesCode":"snogoo","category":"species","order":"Anseriformes","familyCode":"anatid1","familyComName":"Ducks, Geese, and Waterfowl","familySciName":"Anatidae","birdImg":"https://images.unsplash.com/photo-1542252223-c7f5b1142f93?q=75&fm=jpg&w=400&fit=max","wikiURL":"https://en.wikipedia.org/?curid=199013","taxonOrder":"256"}
];

module.exports = birdsData;
